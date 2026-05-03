import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// 👇 COLOQUE AQUI O ID DA AGENDA QUE O SEU SITE USA
const CALENDAR_ID = process.env.CALENDAR_ID || "alugueldeestudiofotografico@gmail.com";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5511995540293@c.us"; 

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
// CONEXÃO WHATSAPP
// =============================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
client.on('qr', (qr) => { console.log(qr); });
client.on('ready', () => { console.log('✅ BOT MESTRE ONLINE E SINCRONIZADO!'); });
client.initialize();

async function sendMessage(chatId, text) {
  try { await client.sendMessage(chatId, text); } catch (e) { console.error(e); }
}

async function getAgendaOcupada() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + 15 * 24 * 60 * 60 * 1000); // Vê os próximos 15 dias
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
      return `- ${inicio.toLocaleDateString("pt-BR")} das ${inicio.toLocaleTimeString("pt-BR", {hour:'2-digit', minute:'2-digit'})} às ${fim.toLocaleTimeString("pt-BR", {hour:'2-digit', minute:'2-digit'})} (${ev.summary})`;
    }).join("\n");
  } catch (e) { return "Erro ao ler a agenda principal."; }
}

// =============================
// CÉREBRO DO ROBÔ
// =============================
async function gerarRespostaGemini(chatId, pergunta, nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const ocupacaoAtual = await getAgendaOcupada();

  const SYSTEM_PROMPT = `
Você é o assistente virtual do Aluguel de Estúdio Fotográfico. Atenda com agilidade e foco comercial.
CLIENTE: ${nomeUsuario}.

🚨 REGRAS DE OURO:
1. MÍNIMO: 2 horas de locação.
2. DISPONIBILIDADE: Consulte SEMPRE a agenda abaixo. Se o horário estiver livre na agenda, pode oferecer, independente de ser domingo ou feriado. Se não estiver na agenda, diga que está ocupado.
3. PREÇOS BELA VISTA: R$ 50/hora (1-2 pessoas). 
4. PREÇOS ACLIMAÇÃO: Seg-Sex R$ 70/hora | Fim de Semana R$ 80/hora. (AB junto: R$ 100/110).
5. GRUPOS 9-12 PESSOAS: Apenas Estúdio AB Aclimação por R$ 160/hora.
6. SINAL: R$ 50 (até 3h) ou 1/3 do valor (4h ou mais). PIX CNPJ: 43.345.289/0001-93.
7. TARIFA NOTURNA: Avise que após as 21h os valores mudam.

⚠️ GATILHO HUMANO (11 99554-0293):
Assuntos logísticos (Portão, Uber), Visitas Técnicas, Equipamentos Extras ou Exceções de Pagamento.

AGENDA REAL SINCRONIZADA:
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

client.on('message', async (msg) => {
  try {
    const chatId = msg.from;
    if (chatId.includes('@g.us') || chatId === 'status@broadcast') return;
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

app.get('/', (req, res) => res.send('Agenda Integrada Online'));
app.listen(PORT);
