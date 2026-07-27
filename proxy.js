// ============================================================
//  proxy.js — SisFisc TCEPE · Jaboatão dos Guararapes (UJ 319)
//  Node.js · sem dependências externas além do "node-fetch"
//
//  Instalar dependências:
//    npm install
//
//  Iniciar:
//    npm start
//
//  Acessar:
//    http://localhost:3000
//
//  Endpoints expostos:
//    GET  /api/determinacoes  → dados da API TCEPE Determinações
//    GET  /api/recomendacoes  → dados da API TCEPE Recomendações
//    GET  /api/status         → estado do cache e última atualização
//    GET  /api/refresh        → forçar atualização imediata do cache
//    GET  /api/prazos         → prazos (texto livre) salvos por processo
//    POST /api/prazos         → salva/atualiza o prazo de um processo
//                                body: { proc, prazo } — persistido em
//                                prazos-overrides.json, visível para
//                                todos que acessarem o link do painel
// ============================================================

// ── CONFIGURAÇÃO ─────────────────────────────────────────────
const CONFIG = {
  PORT: 3000,

  // URLs originais das APIs do TCEPE
  TCEPE_DETERMINACOES: 'https://sistemas.tcepe.tc.br/DadosAbertos/Determinacoes!htmlFormatado?CodigoUJDeterminacao=319',
  TCEPE_RECOMENDACOES: 'https://sistemas.tcepe.tc.br/DadosAbertos/Recomendacoes!htmlFormatado?CodigoUJRecomendacao=319',

  // Tempo de vida do cache em milissegundos para entregar dados quase em tempo real
  CACHE_TTL_MS: 15 * 1000,

  // Timeout de cada requisição ao TCEPE (ms)
  FETCH_TIMEOUT_MS: 15000,

  // Origens permitidas no CORS (ajuste conforme seu ambiente)
  // Use '*' apenas em desenvolvimento; em produção liste os domínios exatos
  CORS_ORIGIN: '*',

  // Intervalo de atualização periódica de cache em segundo plano
  AUTO_REFRESH_MS: 30 * 1000,
};
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();
app.use(cors({ origin: CONFIG.CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── PERSISTÊNCIA DO CAMPO "PRAZO" (TEXTO LIVRE) ─────────────────
// O campo "Prazo" passa a ser preenchido manualmente pelo usuário
// (texto livre, ex.: "30 dias", "até 15/08", "prorrogado"). O valor
// é salvo em disco (prazos-overrides.json) e servido pela API, para
// que qualquer pessoa que acesse o link do painel veja o mesmo dado.
const PRAZOS_FILE = path.join(__dirname, 'prazos-overrides.json');
let prazosOverrides = {};

function loadPrazosOverrides() {
  try {
    if (fs.existsSync(PRAZOS_FILE)) {
      const raw = fs.readFileSync(PRAZOS_FILE, 'utf8');
      prazosOverrides = JSON.parse(raw) || {};
      console.log(`[prazos] ${Object.keys(prazosOverrides).length} prazo(s) carregado(s) de ${PRAZOS_FILE}`);
    }
  } catch (err) {
    console.error('[prazos] Erro ao carregar prazos-overrides.json:', err.message);
    prazosOverrides = {};
  }
}

function savePrazosOverrides() {
  try {
    fs.writeFileSync(PRAZOS_FILE, JSON.stringify(prazosOverrides, null, 2), 'utf8');
  } catch (err) {
    console.error('[prazos] Erro ao salvar prazos-overrides.json:', err.message);
    throw err;
  }
}

loadPrazosOverrides();

// GET  /api/prazos       → devolve todos os prazos salvos { proc: "texto" }
// POST /api/prazos       → body { proc, prazo } salva/atualiza (prazo vazio remove)
app.get('/api/prazos', (req, res) => {
  res.json({ success: true, data: prazosOverrides });
});

app.post('/api/prazos', (req, res) => {
  const { proc, prazo } = req.body || {};

  if (!proc || typeof proc !== 'string' || !proc.trim()) {
    return res.status(400).json({ success: false, error: 'Campo "proc" (número do processo) é obrigatório.' });
  }

  const key = proc.trim();
  const value = typeof prazo === 'string' ? prazo.trim() : '';

  try {
    if (value) {
      prazosOverrides[key] = value;
    } else {
      delete prazosOverrides[key];
    }
    savePrazosOverrides();
    res.json({ success: true, data: prazosOverrides });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Não foi possível salvar o prazo no servidor.' });
  }
});

// Força a página principal a servir o painel estático
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'painel_tcepe_319.html')));

// ── CACHE ─────────────────────────────────────────────────────
const cache = {
  determinacoes: { data: null, fetchedAt: null, error: null },
  recomendacoes: { data: null, fetchedAt: null, error: null },
};

function isFresh(entry) {
  return entry.fetchedAt && (Date.now() - entry.fetchedAt) < CONFIG.CACHE_TTL_MS;
}

// ── PARSER HTML → JSON ────────────────────────────────────────
// A API do TCEPE devolve HTML com uma <table>. Esta função
// transforma as linhas da tabela em um array de objetos JSON.
function decodeHtmlEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// A API do TCEPE devolve os links de Processo/Documento como células cujo
// conteúdo é <a href="javascript:abrirURL('http://etce.tcepe.tc.br/...')">Abrir</a>.
// Extrai a URL real de dentro da chamada abrirURL(...) antes de descartar as tags,
// senão o link se perde e sobra apenas o texto "Abrir".
function extractAbrirURLLink(rawCellHtml) {
  const match = rawCellHtml.match(/abrirURL\(\s*(?:&quot;|&#39;|"|')([\s\S]*?)(?:&quot;|&#39;|"|')\s*\)/i);
  if (!match) return null;
  return decodeHtmlEntities(match[1]).trim();
}

function parseTableHTML(html) {
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  const rows = [];
  let rowMatch;
  let isFirst = true;
  let headers = [];

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const rawCell = cellMatch[1];
      const link = extractAbrirURLLink(rawCell);
      const text = link !== null
        ? link
        : decodeHtmlEntities(
            rawCell.replace(/<[^>]+>/g, ' ')
          ).replace(/\s+/g, ' ').trim();
      cells.push(text);
    }

    if (cells.length === 0) continue;

    if (isFirst) {
      headers = cells;
      isFirst = false;
    } else {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = cells[i] !== undefined ? cells[i] : '';
      });
      rows.push(obj);
    }
  }

  return rows;
}

// ── BUSCA COM TIMEOUT ─────────────────────────────────────────
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao acessar ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── ATUALIZA CACHE ────────────────────────────────────────────
async function refreshCache(key) {
  const url = key === 'determinacoes'
    ? CONFIG.TCEPE_DETERMINACOES
    : CONFIG.TCEPE_RECOMENDACOES;

  console.log(`[${new Date().toISOString()}] Buscando ${key} no TCEPE...`);

  try {
    const html = await fetchWithTimeout(url);
    const data = parseTableHTML(html);
    cache[key] = { data, fetchedAt: Date.now(), error: null };
    console.log(`[${new Date().toISOString()}] ${key}: ${data.length} registros em cache.`);
  } catch (err) {
    cache[key].error = err.message;
    console.error(`[${new Date().toISOString()}] Erro ao buscar ${key}: ${err.message}`);
  }
}

async function refreshAll() {
  await Promise.all([refreshCache('determinacoes'), refreshCache('recomendacoes')]);
}

// ── ROTA GENÉRICA ─────────────────────────────────────────────
async function handleRoute(key, req, res) {
  const forceRefresh = req.query.refresh === '1';
  if (forceRefresh || !isFresh(cache[key])) {
    await refreshCache(key);
  }

  if (cache[key].data) {
    return res.json({
      success: true,
      fromCache: isFresh(cache[key]),
      fetchedAt: new Date(cache[key].fetchedAt).toISOString(),
      total: cache[key].data.length,
      data: cache[key].data,
    });
  }

  return res.status(502).json({
    success: false,
    error: cache[key].error || 'Erro desconhecido ao acessar o TCEPE.',
  });
}

// ── ROTAS ─────────────────────────────────────────────────────
app.get('/api/determinacoes', (req, res) => handleRoute('determinacoes', req, res));
app.get('/api/recomendacoes', (req, res) => handleRoute('recomendacoes', req, res));
app.get('/api/status', (req, res) => {
  res.json({
    server: 'SisFisc Proxy · TCEPE UJ 319',
    uptime: Math.floor(process.uptime()) + 's',
    cache: {
      determinacoes: {
        registros: cache.determinacoes.data?.length ?? null,
        fetchedAt: cache.determinacoes.fetchedAt
          ? new Date(cache.determinacoes.fetchedAt).toISOString() : null,
        expiresIn: cache.determinacoes.fetchedAt
          ? Math.max(0, Math.round((cache.determinacoes.fetchedAt + CONFIG.CACHE_TTL_MS - Date.now()) / 1000)) + 's'
          : null,
        error: cache.determinacoes.error,
      },
      recomendacoes: {
        registros: cache.recomendacoes.data?.length ?? null,
        fetchedAt: cache.recomendacoes.fetchedAt
          ? new Date(cache.recomendacoes.fetchedAt).toISOString() : null,
        expiresIn: cache.recomendacoes.fetchedAt
          ? Math.max(0, Math.round((cache.recomendacoes.fetchedAt + CONFIG.CACHE_TTL_MS - Date.now()) / 1000)) + 's'
          : null,
        error: cache.recomendacoes.error,
      },
    },
  });
});
app.get('/api/refresh', async (req, res) => {
  await refreshAll();
  res.json({ success: true, message: 'Cache atualizado', status: 'ok' });
});

// ── INICIALIZAÇÃO ─────────────────────────────────────────────
app.listen(CONFIG.PORT, async () => {
  console.log(`\nSisFisc Proxy iniciado na porta ${CONFIG.PORT}`);
  console.log(`  http://localhost:${CONFIG.PORT}`);
  console.log(`  GET http://localhost:${CONFIG.PORT}/api/determinacoes`);
  console.log(`  GET http://localhost:${CONFIG.PORT}/api/recomendacoes`);
  console.log(`  GET http://localhost:${CONFIG.PORT}/api/status\n`);

  await refreshAll();
  setInterval(refreshAll, CONFIG.AUTO_REFRESH_MS);
});
