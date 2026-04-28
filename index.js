import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";
const TIMEZONE = "America/Sao_Paulo";

// 👇 O ID do Admin é o seu WhatsApp com @c.us (Ex: 5511995540293@c.us)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5511995540293@c.us"; 

const conversationMemory = new Map(); 
const userProfiles = new Map(); // Caderneta de Clientes

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
  console.log("✅ Google Calendar conectado.");
} catch (error) { console.error("❌ Erro Calendar:", error); }

// =============================
// CONEXÃO WHATSAPP
// =============================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});
client.on('qr', (qr) => {
  console.log('\n--- COPIE O TEXTO ABAIXO RAPIDAMENTE ---');
  console.log(qr);
  console.log('----------------------------------------\n');
});
client.on('ready', () => {
  console.log('✅ Robô do WhatsApp pronto!');
});

client.initialize();

// =============================
// FUNÇÕES DE APOIO
// =============================
async function sendMessage(chatId, text) {
  if (!chatId || !text) return;
  try {
    await client.sendMessage(chatId, text);
  } catch (e) { console.error("Erro WhatsApp:", e); }
}

async function getAgendaOcupada() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000); 
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: agora.toISOString(),
      timeMax: limite.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    if (!res.data.items || res.data.items.length === 0) return "Agenda livre.";
    return res.data.items.map(ev => {
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const fim = new Date(ev.end.dateTime || ev.end.date);
      return `- ${inicio.toLocaleDateString("pt-BR", { day: '2-digit', month: '2-digit' })} das ${inicio.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })} às ${fim.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })} (${ev.summary})`;
    }).join("\n");
  } catch (e) { return "Erro na agenda."; }
}

// =============================
// CÉREBRO DO ROBÔ
// =============================
async function gerarRespostaGemini(chatId, pergunta, historico = [], nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const dataAtual = new Date();
  const ocupacaoAtual = await getAgendaOcupada();
  const perfil = userProfiles.get(chatId);

  const SYSTEM_PROMPT = `
Você é o assistente oficial do Aluguel de Estúdio Fotográfico.
CLIENTE: ${nomeUsuario}. Se for saudação, diga "Oi ${nomeUsuario}, como posso ajudar?".
${perfil ? `CLIENTE CADASTRADO: ${perfil.nome} | ${perfil.telefone}.` : ""}
HOJE: ${dataAtual.toLocaleDateString("pt-BR")}.
OCUPADO: ${ocupacaoAtual}

REGRAS:
1. Só diga que está ocupado se for o MESMO estúdio. Estúdios são independentes.
2. 30 min de intervalo obrigatório.
3. WhatsApp Humano (11 99554-0293) apenas para: +8 pessoas, madrugadas ou dúvidas complexas.
4. Para reserva, peça: Data, Hora, Estúdio, Pessoas. (E Nome/Tel se não souber).

JSON FINAL: {"nome":"","telefone":"","data":"YYYY-MM-DD","hora_inicio":"HH:MM","duracao_minutos":120,"estudio":"","qtd_pessoas":2,"valor_total":140}
`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nCliente: ${pergunta}` }] }] }),
    });
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (e) { return "Erro de conexão."; }
}

// =============================
// WEBHOOK WHATSAPP
// =============================
client.on('message', async (msg) => {
  try {
    const chatId = msg.from;
    const texto = msg.body;
    if (chatId.includes('@g.us') || chatId === 'status@broadcast') return;

    const contact = await msg.getContact();
    const nomeUsuario = contact.pushname || "Cliente";

    if (chatId !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `👤 ${nomeUsuario}: ${texto}`);

    if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
    const historico = conversationMemory.get(chatId);

    const resposta = await gerarRespostaGemini(chatId, texto, historico, nomeUsuario);
    const respostaSemJson = resposta.replace(/```json[\s\S]*?```/i, "").trim();

    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const dados = JSON.parse(jsonMatch[1]);
      userProfiles.set(chatId, { nome: dados.nome, telefone: dados.telefone });
      // Aqui entraria a função criarEvento (mesma lógica do Telegram)
      await sendMessage(chatId, "Agendando... ✅");
      // (Simplificado para o código não ficar gigante)
    } else {
      await sendMessage(chatId, respostaSemJson);
      if (chatId !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🤖 Bot: ${respostaSemJson}`);
    }
  } catch (e) { console.error(e); }
});

app.get('/', (req, res) => res.send('WhatsApp Bot Ativo'));
app.listen(PORT);
// tentativa de terca
