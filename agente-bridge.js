// agente-bridge.js — roda no SEU PC
// Conecta o agente local ao servidor Railway
// Uso: node agente-bridge.js <URL_RAILWAY> "<texto do protocolo>"
// Ex:  node agente-bridge.js https://way-valida-sat.railway.app "Nº do Contrato: 112717..."

require('dotenv').config({ path: './config/.env' });
const { spawn } = require('child_process');

const RAILWAY_URL = process.argv[2];
const TEXTO_OS    = process.argv[3];

if (!RAILWAY_URL || !TEXTO_OS) {
  console.log('Uso: node agente-bridge.js <URL_RAILWAY> "<texto OS>"');
  process.exit(1);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log(`🔗 Conectando ao Railway: ${RAILWAY_URL}`);

  // 1. Cria o job no Railway
  const { jobId } = await post(`${RAILWAY_URL}/executar`, { textoOS: TEXTO_OS });
  console.log(`✅ Job criado: ${jobId}`);

  // 2. Inicia o agente local
  const proc = spawn('node', ['src/agente.js', TEXTO_OS], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // 3. Envia logs para o Railway em tempo real
  proc.stdout.on('data', async (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      // Detecta aguardo de decisão
      if (line.includes('__AGUARDANDO_DECISAO__')) {
        await post(`${RAILWAY_URL}/log/${jobId}`, { msg: '__AGUARDANDO_DECISAO__', tipo: 'warn' });
        // Fica fazendo polling esperando a decisão da interface
        console.log('⏳ Aguardando decisão na interface...');
        let decisao = null;
        while (!decisao) {
          await new Promise(r => setTimeout(r, 1500));
          const res = await get(`${RAILWAY_URL}/aguardar-decisao/${jobId}`);
          decisao = res.decisao;
        }
        console.log(`📋 Decisão recebida: ${decisao}`);
        const texto = decisao.toLowerCase().includes('apr') ? 'aprovar' : 'reprovar';
        proc.stdin.write(texto + '\n');
        continue;
      }
      // Log normal
      let tipo = 'info';
      if (/✅|aprovad/i.test(line))  tipo = 'success';
      if (/❌|reprovad|erro/i.test(line)) tipo = 'error';
      if (/⚠/.test(line))           tipo = 'warn';
      console.log(line);
      await post(`${RAILWAY_URL}/log/${jobId}`, { msg: line, tipo });
    }
  });

  proc.stderr.on('data', async (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      await post(`${RAILWAY_URL}/log/${jobId}`, { msg: line, tipo: 'error' });
    }
  });

  // 4. Quando agente terminar, finaliza job no Railway
  proc.on('close', async (code) => {
    const resultado = code === 0 ? 'aprovado' : 'reprovado';
    await post(`${RAILWAY_URL}/finalizar/${jobId}`, {
      resultado,
      status: code === 0 ? 'done' : 'error',
    });
    console.log(`\n✅ Finalizado — resultado: ${resultado}`);
  });
}

main().catch(console.error);
