import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";
import QRCode from "qrcode";
const { Client, LocalAuth } = pkg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ID da agenda padrão (usado só se CALENDAR_IDS não estiver definido)
const CALENDAR_ID = process.env.CALENDAR_ID || "alugueldeestudiofotografico@gmail.com";

// ✅ NOVO: lê UMA ou MAIS agendas.
// No Railway, defina a variável CALENDAR_IDS com os IDs separados por vírgula.
// Ex.: id-da-aclimacao@group.calendar.google.com, id-da-belavista@group.calendar.google.com
const CALENDAR_IDS = (process.env.CALENDAR_IDS || CALENDAR_ID)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5511995540293@c.us";

// 🎛️ VARIÁVEL DE CONTROLE
// Começa DESLIGADO de propósito: o robô sobe e lê a agenda, mas NÃO responde
// clientes sozinho. Para ligar o respondedor, mande "!ativar" pelo WhatsApp de admin.
let botAtivo = false;

// =============================
// GOOGLE CALENDAR
// =============================
let calendar;
try {
  const googleConfig = JSON.parse(process.env.GOOGLE_CONFIG);
  const privateKey = googleConfig.private_key.replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: googleConfig.client_email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendar = google.calendar({ version: "v3", auth });
} catch (error) { console.error("Erro Calendar:", error); }

// =============================
// CONEXÃO WHATSAPP (ANTI-QUEDA OPTIMIZED)
// =============================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});
// Guarda o QR mais recente para mostrar numa página web (mais fácil de escanear)
let ultimoQR = null;
let whatsappConectado = false;

client.on('qr', (qr) => {
  ultimoQR = qr;
  whatsappConectado = false;
  console.log("========== COPIE O TEXTO DO QR ABAIXO ==========");
  console.log(qr);
  console.log("=== Cole em um gerador de QR online (ex.: qrcode-monkey) e escaneie ===");
});
client.on('ready', () => {
  whatsappConectado = true;
  ultimoQR = null;
  console.log('✅ BOT MESTRE ONLINE E SINCRONIZADO!');
});
client.initialize();

async function sendMessage(chatId, text) {
  try { await client.sendMessage(chatId, text); } catch (e) { console.error(e); }
}

// ✅ NOVO: lê TODAS as agendas de CALENDAR_IDS, junta e ordena por horário
async function getAgendaOcupada() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + 15 * 24 * 60 * 60 * 1000);
    let todos = [];

    for (const calId of CALENDAR_IDS) {
      try {
        const res = await calendar.events.list({
          calendarId: calId,
          timeMin: agora.toISOString(),
          timeMax: limite.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });
        if (res.data.items) todos = todos.concat(res.data.items);
      } catch (e) {
        console.error(`Erro ao ler a agenda ${calId}:`, e.message);
      }
    }

    if (todos.length === 0) return "Agenda livre.";

    todos.sort((a, b) =>
      new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date)
    );

    return todos.map(ev => {
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const fim = new Date(ev.end.dateTime || ev.end.date);
      return `- ${inicio.toLocaleDateString("pt-BR")} das ${inicio.toLocaleTimeString("pt-BR", {hour:'2-digit', minute:'2-digit'})} às ${fim.toLocaleTimeString("pt-BR", {hour:'2-digit', minute:'2-digit'})} (${ev.summary})`;
    }).join("\n");
  } catch (e) { return "Erro ao ler as agendas."; }
}

// =============================
// MODO ENSAIO — CONFIRMAÇÃO (manda só pro admin, nunca pro cliente)
// =============================

// tira acentos e deixa minúsculo, pra facilitar a busca
function normalizar(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// tenta achar um telefone brasileiro dentro do texto do evento
function extrairTelefone(texto) {
  if (!texto) return null;
  const m = texto.match(/(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/);
  if (!m) return null;
  let num = m[0].replace(/\D/g, "");
  if (num.length <= 11) num = "55" + num; // adiciona o código do Brasil se faltar
  return num;
}

// monta a mensagem que seria enviada ao cliente
function montarMensagemConfirmacao(ev) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const data = inicio.toLocaleDateString("pt-BR", { weekday: 'long', day: '2-digit', month: '2-digit' });
  const hora = inicio.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' });
  return `Olá! 😊 Aqui é do Estúdio ZM.\nEstou passando para confirmar sua reserva do dia ${data} às ${hora}.\nEstá tudo certo para você? Se precisar ajustar algo, é só me responder por aqui. 📸`;
}

// procura eventos marcados como "pré" nas duas agendas
async function coletarEventosPre(diasFrente = 7) {
  const agora = new Date();
  const limite = new Date(agora.getTime() + diasFrente * 24 * 60 * 60 * 1000);
  let achados = [];
  for (const calId of CALENDAR_IDS) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: agora.toISOString(),
        timeMax: limite.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      for (const ev of (res.data.items || [])) {
        const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
        if (/\bpre\b/.test(alvo)) { // considera "pré" quando aparece como palavra
          achados.push({ ev, calId });
        }
      }
    } catch (e) { console.error(`Erro ao ler a agenda ${calId}:`, e.message); }
  }
  return achados;
}

// roda o ensaio e manda o resultado SÓ pro admin
async function rodarEnsaioConfirmacoes() {
  await sendMessage(ADMIN_CHAT_ID, "🧪 MODO ENSAIO: procurando reservas 'pré' nas suas agendas...");
  const achados = await coletarEventosPre(7);
  if (achados.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, "Nenhuma reserva com 'pré' encontrada nos próximos 7 dias.\n\nSe você marca as pré-reservas de outro jeito, me diz como que eu ajusto o filtro.");
    return;
  }
  await sendMessage(ADMIN_CHAT_ID, `Encontrei ${achados.length} reserva(s) "pré". Abaixo está o que eu enviaria a cada cliente. NADA foi enviado a eles. 👇`);
  for (const { ev } of achados) {
    const inicio = new Date(ev.start.dateTime || ev.start.date);
    const data = inicio.toLocaleDateString("pt-BR");
    const hora = inicio.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' });
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    const msg = montarMensagemConfirmacao(ev);
    const bloco = `━━━━━━━━━━\n📌 ${ev.summary || "(sem título)"}\n🗓️ ${data} às ${hora}\n📞 ${tel ? tel : "⚠️ telefone NÃO encontrado no evento"}\n\n✉️ Mensagem que eu enviaria:\n${msg}`;
    await sendMessage(ADMIN_CHAT_ID, bloco);
  }
}

// =============================
// CÉREBRO DO ROBÔ
// =============================
async function gerarRespostaGemini(chatId, pergunta, nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const ocupacaoAtual = await getAgendaOcupada();

  const SYSTEM_PROMPT = `
Você é o assistente virtual do Aluguel de Estúdio Fotográfico. Seu objetivo é fechar reservas e informar o cliente.
CLIENTE: ${nomeUsuario}.

🚨 REGRAS DE OURO (NUNCA IGNORE):
1. MÍNIMO: 2 horas de locação.
2. DISPONIBILIDADE: Consulte SEMPRE a agenda abaixo. Se estiver livre, ofereça.
3. PREÇOS BELA VISTA: R$ 50/hora (1-2 pessoas).
4. PREÇOS ACLIMAÇÃO: Seg-Sex R$ 70/hora | Fim de Semana R$ 80/hora. (AB junto: R$ 100/110).
5. GRUPOS 9-12 PESSOAS: Apenas Estúdio AB na Aclimação por R$ 160/hora.
6. SINAL: R$ 50 (até 3h) ou 1/3 do valor (4h ou mais). PIX CNPJ: 43.345.289/0001-93.
7. TARIFA NOTURNA: Após as 21h os valores mudam. Sempre avise isso se o cliente quiser horários tarde da noite.

📄 INFORMAÇÕES E PDF (REGRA CRUCIAL):
- SEMPRE que o cliente pedir valores, fotos, informações gerais ou perguntar "como funciona", você DEVE dizer que temos um PDF completo e enviar os links abaixo:
- PDF GERAL COM TODOS OS VALORES: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing
- FOTOS UNIDADE ACLIMAÇÃO: https://drive.google.com/drive/folders/100GPqd9sWFRtEE5YPZCYhyv_DkBNV_G9
- FOTOS UNIDADE BELA VISTA: https://drive.google.com/drive/folders/1Navk6o2Gy9cDlD9FKAuizH8hd3nTMLEW

⚠️ GATILHO HUMANO (11 99554-0293):
- NÃO tente resolver: Assuntos logísticos (Portão, Uber), Visitas Técnicas agendadas, Equipamentos Específicos (Lentes, Snoot, Projetor) ou Exceções de Pagamento. Encaminhe para o número acima.

AGENDA REAL ATUALIZADA:
${ocupacaoAtual}
`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nCliente: ${pergunta}` }] }] }),
    });
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (e) { return "Um momento, vou conferir com a recepção."; }
}

// =============================
// PROCESSAMENTO DE MENSAGENS
// =============================
client.on('message', async (msg) => {
  try {
    const chatId = msg.from;
    if (chatId.includes('@g.us') || chatId === 'status@broadcast') return;

    const textoMensagem = msg.body.trim().toLowerCase();

    // 🆔 DIAGNÓSTICO: responde a QUALQUER número com o próprio ID.
    // Serve para descobrir o valor exato do ADMIN_CHAT_ID.
    if (textoMensagem === '!meuid') {
      await sendMessage(chatId, `Seu ID é:\n${chatId}\n\nÉ esse valor exato que deve ir no ADMIN_CHAT_ID.`);
      return;
    }

    // 🔒 COMANDOS EXCLUSIVOS DO ADMIN PARA CONTROLAR O BOT
    if (chatId === ADMIN_CHAT_ID) {
      if (textoMensagem === '!desativar' || textoMensagem === '!bot off') {
        botAtivo = false;
        await sendMessage(ADMIN_CHAT_ID, "❌ O robô foi DESATIVADO. Pode responder manualmente de forma tranquila!");
        return;
      }
      if (textoMensagem === '!ativar' || textoMensagem === '!bot on') {
        botAtivo = true;
        await sendMessage(ADMIN_CHAT_ID, "✅ O robô foi ATIVADO! Voltei a atender os clientes.");
        return;
      }
      if (textoMensagem === '!status') {
        await sendMessage(ADMIN_CHAT_ID, `🤖 O robô está atualmente: ${botAtivo ? "LIGADO ✅" : "DESLIGADO ❌"}`);
        return;
      }
      // 🔎 TESTE: mostra o que o robô está lendo das agendas (não liga o respondedor)
      if (textoMensagem === '!agenda') {
        await sendMessage(ADMIN_CHAT_ID, "🔎 Lendo as agendas, um instante...");
        const lista = await getAgendaOcupada();
        await sendMessage(ADMIN_CHAT_ID, `📅 AGENDA (próximos 15 dias):\n\n${lista}`);
        return;
      }
      // 🧪 ENSAIO: monta as confirmações "pré" e manda só pra você (nada vai pro cliente)
      if (textoMensagem === '!testar') {
        await rodarEnsaioConfirmacoes();
        return;
      }
    }

    // Se o bot estiver pausado/desativado, ignora as mensagens e deixa você falar livremente
    if (!botAtivo) return;

    // Comportamento normal quando ativo
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));

    const contact = await msg.getContact();
    const nome = contact.pushname || "Cliente";

    const resposta = await gerarRespostaGemini(chatId, msg.body, nome);
    await sendMessage(chatId, resposta);

    if (chatId !== ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID, `👤 ${nome}: ${msg.body}\n🤖 Bot: ${resposta}`);
    }
  } catch (e) { console.error(e); }
});

app.get('/', (req, res) => res.send('Bot Online com Chave de Ativação e Proteção Anti-Queda'));

// 📲 Página para conectar o WhatsApp escaneando um QR de verdade
app.get('/qr', async (req, res) => {
  if (whatsappConectado) {
    res.send("<h2 style='font-family:sans-serif'>✅ WhatsApp já está conectado.</h2>");
    return;
  }
  if (!ultimoQR) {
    res.send("<meta http-equiv='refresh' content='3'><h2 style='font-family:sans-serif'>Gerando o QR... aguarde alguns segundos.</h2>");
    return;
  }
  try {
    const dataUrl = await QRCode.toDataURL(ultimoQR, { width: 320, margin: 2 });
    res.send(`<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="20">
      <title>Conectar WhatsApp</title>
      <style>body{font-family:sans-serif;text-align:center;background:#111;color:#eee;padding:24px}
      img{background:#fff;padding:12px;border-radius:12px}</style></head>
      <body><h2>Escaneie para conectar o robô</h2>
      <img src="${dataUrl}" alt="QR Code"/>
      <p>WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
      <p style="color:#888">A página se atualiza sozinha a cada 20s com um QR novo. É só manter aberta.</p>
      </body></html>`);
  } catch (e) {
    res.status(500).send("Erro ao gerar o QR: " + e.message);
  }
});

app.listen(PORT);
