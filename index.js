import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";
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
client.on('qr', (qr) => { console.log(qr); });
client.on('ready', () => { console.log('✅ BOT MESTRE ONLINE E SINCRONIZADO!'); });
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
app.listen(PORT);
