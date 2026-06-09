// server.js — Way Valida SAT (Railway)
// A interface roda aqui, o agente roda no PC local
require('dotenv').config({ path: './config/.env' });
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

const PORT         = process.env.PORT || 3333;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const JOBS_FILE    = '/tmp/way-jobs.json';

// ─── Autenticação ─────────────────────────────────────────────────────────────
function verificarToken(req) {
  if (!ACCESS_TOKEN) return true;
  const auth  = req.headers['authorization'] || '';
  const query = (() => { try { return new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch { return ''; } })();
  return auth === `Bearer ${ACCESS_TOKEN}` || query === ACCESS_TOKEN;
}

// ─── Jobs com persistência ────────────────────────────────────────────────────
function carregarJobs() {
  try {
    if (require('fs').existsSync(JOBS_FILE)) {
      return new Map(Object.entries(JSON.parse(require('fs').readFileSync(JOBS_FILE, 'utf-8'))));
    }
  } catch {}
  return new Map();
}

function salvarJobs() {
  try {
    const obj = {};
    for (const [k, v] of jobs.entries()) {
      obj[k] = { ...v, logs: (v.logs || []).map(l => ({ ts: l.ts, msg: l.msg, tipo: l.tipo })) };
    }
    require('fs').writeFileSync(JOBS_FILE, JSON.stringify(obj));
  } catch {}
}

const jobs = carregarJobs();

function criarJob(id, textoOS) {
  jobs.set(id, {
    status: 'aguardando_agente',
    logs: [],
    resultado: null,
    motivo: null,
    textoOS: textoOS,       // guarda para o watcher buscar
    coletado: false,        // watcher já pegou?
  });
  return jobs.get(id);
}

function addLog(job, msg, tipo = 'info') {
  const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  job.logs.push({ ts, msg, tipo });
  salvarJobs();
}

// ─── Roteador HTTP ────────────────────────────────────────────────────────────
function responder(res, status, body, tipo = 'application/json') {
  const data = tipo === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': tipo,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { responder(res, 204, ''); return; }

  // GET / → serve index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) { responder(res, 404, { erro: 'index.html não encontrado' }); return; }
    const html = fs.readFileSync(htmlPath, 'utf-8');
    responder(res, 200, html, 'text/html; charset=utf-8');
    return;
  }

  // POST /executar → cria job e aguarda agente externo
  if (req.method === 'POST' && url === '/executar') {
    if (!verificarToken(req)) { responder(res, 401, { erro: 'Não autorizado' }); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { textoOS } = JSON.parse(body);
        if (!textoOS || !textoOS.trim()) { responder(res, 400, { erro: 'textoOS é obrigatório' }); return; }
        const jobId = Date.now().toString();
        const job   = criarJob(jobId, textoOS.trim());
        addLog(job, '🚀 Aguardando watcher local...', 'info');
        responder(res, 200, { ok: true, jobId });
      } catch (e) {
        responder(res, 400, { erro: 'JSON inválido' });
      }
    });
    return;
  }

  // POST /log/:jobId → agente externo envia logs em tempo real
  const logMatch = url.match(/^\/log\/(.+)$/);
  if (req.method === 'POST' && logMatch) {
    const jobId = logMatch[1];
    const job   = jobs.get(jobId);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { msg, tipo, imagem, link } = JSON.parse(body);
        if (!job) { responder(res, 404, { erro: 'Job não encontrado' }); return; }
        // Detecta sinal de aguardo de decisão
        if (msg && msg.includes('__AGUARDANDO_DECISAO__')) {
          job.status = 'aguardando_decisao';
          addLog(job, '⚖️ Laudo gerado — aguardando decisão', 'warn');
        } else if (msg) {
          job.status = 'running';
          // Guarda imagem base64 se existir
          const entry = { ts: new Date().toLocaleTimeString('pt-BR', { hour12: false }), msg, tipo: tipo || 'info' };
          if (imagem) entry.imagem = imagem;
          if (link) entry.link = link;
          job.logs.push(entry);
        }
        responder(res, 200, { ok: true });
      } catch (e) {
        responder(res, 400, { erro: 'JSON inválido' });
      }
    });
    return;
  }

  // POST /finalizar/:jobId → agente externo informa resultado final
  const finMatch = url.match(/^\/finalizar\/(.+)$/);
  if (req.method === 'POST' && finMatch) {
    const jobId = finMatch[1];
    const job   = jobs.get(jobId);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { resultado, motivo, status } = JSON.parse(body);
        if (!job) { responder(res, 404, { erro: 'Job não encontrado' }); return; }
        job.resultado = resultado;
        job.motivo    = motivo || null;
        job.status    = status || 'done';
        addLog(job, resultado === 'aprovado' ? '✅ OS Aprovada' : '❌ OS Reprovada',
               resultado === 'aprovado' ? 'success' : 'error');
        responder(res, 200, { ok: true });
      } catch (e) {
        responder(res, 400, { erro: 'JSON inválido' });
      }
    });
    return;
  }

  // POST /decisao/:jobId → interface envia decisão para o agente via polling
  const decisaoMatch = url.match(/^\/decisao\/(.+)$/);
  if (req.method === 'POST' && decisaoMatch) {
    const jobId = decisaoMatch[1];
    const job   = jobs.get(jobId);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { decisao } = JSON.parse(body);
        if (!job) { responder(res, 404, { erro: 'Job não encontrado' }); return; }
        job.decisaoPendente = decisao;
        job.status = 'running';
        addLog(job, `📋 Decisão enviada: ${decisao.toUpperCase()}`, 'success');
        responder(res, 200, { ok: true });
      } catch (e) {
        responder(res, 400, { erro: 'JSON inválido' });
      }
    });
    return;
  }

  // GET /aguardar-decisao/:jobId → agente externo faz polling da decisão
  const aguardarMatch = url.match(/^\/aguardar-decisao\/(.+)$/);
  if (req.method === 'GET' && aguardarMatch) {
    const jobId = aguardarMatch[1];
    const job   = jobs.get(jobId);
    if (!job) { responder(res, 404, { erro: 'Job não encontrado' }); return; }
    if (job.decisaoPendente) {
      const decisao = job.decisaoPendente;
      job.decisaoPendente = null;
      responder(res, 200, { decisao });
    } else {
      responder(res, 200, { decisao: null });
    }
    return;
  }

  // GET /jobs-pendentes → watcher busca jobs aguardando execução
  if (req.method === 'GET' && url === '/jobs-pendentes') {
    const pendentes = [];
    for (const [jobId, job] of jobs.entries()) {
      if (job.status === 'aguardando_agente' && !job.coletado) {
        job.coletado = true;  // marca como coletado
        job.status   = 'running';
        pendentes.push({ jobId, textoOS: job.textoOS });
      }
    }
    responder(res, 200, { jobs: pendentes });
    return;
  }

  // GET /status/:jobId → interface consulta estado do job
  const statusMatch = url.match(/^\/status\/(.+)$/);
  if (req.method === 'GET' && statusMatch) {
    const jobId = statusMatch[1];
    const job   = jobs.get(jobId);
    if (!job) { responder(res, 404, { erro: 'Job não encontrado' }); return; }
    responder(res, 200, {
      status:    job.status,
      logs:      job.logs,
      resultado: job.resultado,
      motivo:    job.motivo,
    });
    return;
  }

  // POST /revalidar/:jobId → cria novo job com mesmo textoOS
  const revalidarMatch = url.match(/^\/revalidar\/(.+)$/);
  if (req.method === 'POST' && revalidarMatch) {
    if (!verificarToken(req)) { responder(res, 401, { erro: 'Não autorizado' }); return; }
    const jobIdOriginal = revalidarMatch[1];
    const jobOriginal   = jobs.get(jobIdOriginal);
    if (!jobOriginal || !jobOriginal.textoOS) {
      responder(res, 404, { erro: 'Job original não encontrado' }); return;
    }
    const novoJobId = Date.now().toString();
    const novoJob   = criarJob(novoJobId, jobOriginal.textoOS);
    addLog(novoJob, '🔄 Revalidação iniciada...', 'info');
    responder(res, 200, { ok: true, jobId: novoJobId });
    return;
  }

  responder(res, 404, { erro: 'Rota não encontrada' });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   Way Valida SAT — Railway           ║');
  console.log(`  ║   Porta: ${PORT}                        ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});