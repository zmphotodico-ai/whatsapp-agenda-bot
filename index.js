import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";
import QRCode from "qrcode";
import cron from "node-cron";
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
  authStrategy: new LocalAuth({ dataPath: "/app/.wwebjs_auth" }),
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
      return `- ${inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} das ${inicio.toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour:'2-digit', minute:'2-digit'})} às ${fim.toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour:'2-digit', minute:'2-digit'})} (${ev.summary})`;
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

// extrai o nome do cliente da descrição (primeira palavra/nome, ignorando "Aluguel", hashtags e telefone)
function extrairNome(ev) {
  let desc = (ev.description || "").split("\n")[0].trim();
  if (!desc) return null;
  desc = desc.replace(/#/g, " ");                 // remove hashtags
  desc = desc.replace(/\baluguel\b/gi, " ");      // remove a palavra "Aluguel" em qualquer lugar
  desc = desc.replace(/\s*(\+?55)?[\s(]*\d{2}[\s).-]*\d.*$/, ""); // corta a partir do telefone
  desc = desc.replace(/\s*R\$.*/i, "");           // tira preço, se estiver junto
  desc = desc.replace(/\s+/g, " ").trim();
  return desc || null;
}

// extrai o estúdio do título, mesmo com bagunça (pré, barras, espaços).
// Estúdios válidos: AB, A, B, C, D (Aclimação) e 1, 2, 3 (Bela Vista).
function extrairEstudio(ev) {
  let t = (ev.summary || "").toUpperCase();
  // remove qualquer variação de "pré/pre/pré pré"
  t = t.replace(/PR[EÉ]/g, " ");
  // remove tudo que parece horário (ex.: 19:30-22:30, 10/18, 08-20)
  t = t.replace(/\d{1,2}\s*[:.]?\s*\d{0,2}\s*[-–/]\s*\d{1,2}\s*[:.]?\s*\d{0,2}/g, " ");
  // troca barras por espaço e limpa
  t = t.replace(/[\/]/g, " ").replace(/\s+/g, " ").trim();
  // procura o estúdio como palavra isolada, na ordem (AB antes de A/B)
  const candidatos = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  const tokens = t.split(" ").filter(Boolean);
  for (const c of candidatos) {
    if (tokens.includes(c)) return c;
  }
  return null; // não reconhecido
}

// TABELA DE VALORES POR HORA — faixa fixa de 3 a 5 pessoas
// (o restante é cobrado no dia). semana = seg-sex | fds = sáb, dom e feriado
const TABELA_PRECOS = {
  aclimacao: {
    semana: { A: 80, B: 80, C: 80, D: 80, AB: 110 },
    fds:    { A: 90, B: 90, C: 90, D: 90, AB: 120 },
  },
  belavista: {
    semana: { "1": 80, "2": 60, "3": 70 },
    fds:    { "1": 90, "2": 80, "3": 80 },
  },
};

// calcula total e sinal a partir do evento. Retorna null se não achar o preço.
function calcularValores(ev, ehAclimacao) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const horas = (fim - inicio) / (1000 * 60 * 60);
  if (!horas || horas <= 0) return null;

  // dia da semana no fuso de SP
  const diaTxt = inicio.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const ehFimDeSemana = (diaTxt === "Sat" || diaTxt === "Sun");
  const periodo = ehFimDeSemana ? "fds" : "semana";

  const unidade = ehAclimacao ? "aclimacao" : "belavista";
  const estudioBruto = extrairEstudio(ev).toUpperCase().replace(/\s/g, "");
  const valorHora = TABELA_PRECOS[unidade][periodo][estudioBruto];
  if (!valorHora) return null; // estúdio não reconhecido na tabela

  const total = Math.round(horas * valorHora);
  let sinal = Math.floor((total / 3) / 10) * 10; // arredonda pra baixo, múltiplo de 10
  if (sinal < 50) sinal = 50; // sinal mínimo
  return { total, sinal };
}

// monta a mensagem que seria enviada ao cliente
// calId indica de qual agenda o evento veio (para escolher o endereço da unidade)
function montarMensagemConfirmacao(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const horaInicio = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const horaFim = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");

  // a PRIMEIRA agenda de CALENDAR_IDS é a Aclimação; a segunda é a Bela Vista
  const ehAclimacao = (CALENDAR_IDS[0] === calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
  const estudio = extrairEstudio(ev);
  const textoEstudio = estudio ? `, no Estúdio ${estudio}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";

  const valores = calcularValores(ev, ehAclimacao);
  const linhaValor = valores
    ? `\n\nSinal para reservar: R$ ${valores.sinal}`
    : "";

  return `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio ${dataExtenso}, das ${horaInicio} às ${horaFim}${textoEstudio}.\n${endereco}${linhaValor}\n\nPIX/CNPJ\nzmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// procura eventos marcados como "pré" nas duas agendas
async function coletarEventosPre(diasFrente = 90) {
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
        // pula clientes com combinado diferente (marcados com zm, #zm, # zm, ZM...)
        if (/#?\s*\bzm\b/.test(alvo)) continue;
        if (/\bpre\b/.test(alvo)) { // considera "pré" quando aparece como palavra
          achados.push({ ev, calId });
        }
      }
    } catch (e) { console.error(`Erro ao ler a agenda ${calId}:`, e.message); }
  }
  return achados;
}

// lista as reservas "pré" que estão SEM telefone, pra facilitar o preenchimento
async function listarSemTelefone() {
  const achados = await coletarEventosPre(90);
  const semTel = [];
  for (const { ev } of achados) {
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    if (!tel) semTel.push(ev);
  }
  if (semTel.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, "✅ Todas as reservas 'pré' já têm telefone. Nada a preencher!");
    return;
  }
  let msg = `📵 ${semTel.length} reserva(s) 'pré' SEM telefone (preencher na descrição):\n`;
  for (const ev of semTel) {
    const inicio = new Date(ev.start.dateTime || ev.start.date);
    const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const hora = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    msg += `\n━━━━━━\n📌 ${ev.summary || "(sem título)"}\n🗓️ ${data} às ${hora}\n👤 ${extrairNome(ev) || "(sem nome)"}`;
  }
  await sendMessage(ADMIN_CHAT_ID, msg);
}

// monta uma linha curta de uma reserva (para a lista dentro da mensagem agrupada)
function montarLinhaReserva(ev) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const est = extrairEstudio(ev);
  const textoEst = est ? `, Estúdio ${est}` : "";
  return `• ${data}, das ${hi} às ${hf}${textoEst}`;
}

// escolhe o nome mais completo entre as reservas do mesmo cliente
function escolherNome(eventos) {
  let melhor = "";
  for (const { ev } of eventos) {
    const nome = extrairNome(ev) || "";
    if (nome.length > melhor.length) melhor = nome;
  }
  return melhor || null;
}

// monta a mensagem AGRUPADA (uma ou várias datas do mesmo cliente)
function montarMensagemAgrupada(eventos) {
  // ordena as reservas por data
  eventos.sort((a, b) =>
    new Date(a.ev.start.dateTime || a.ev.start.date) - new Date(b.ev.start.dateTime || b.ev.start.date)
  );
  const nome = escolherNome(eventos);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";

  // endereço: usa o da unidade da primeira reserva
  const ehAclimacao = (CALENDAR_IDS[0] === eventos[0].calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";

  // soma os sinais
  let sinalTotal = 0;
  let temValor = false;
  for (const { ev, calId } of eventos) {
    const acl = (CALENDAR_IDS[0] === calId);
    const v = calcularValores(ev, acl);
    if (v) { sinalTotal += v.sinal; temValor = true; }
  }

  const linhas = eventos.map(({ ev }) => montarLinhaReserva(ev)).join("\n");
  const abertura = eventos.length > 1
    ? `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio nas seguintes datas:`
    : `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio:`;
  const linhaValor = temValor ? `\n\nSinal para reservar: R$ ${sinalTotal}` : "";

  return `${abertura}\n\n${linhas}\n${endereco}${linhaValor}\n\nPIX/CNPJ\nzmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// roda o ensaio e manda o resultado SÓ pro admin
async function rodarEnsaioConfirmacoes() {
  await sendMessage(ADMIN_CHAT_ID, "🧪 MODO ENSAIO: procurando reservas 'pré' nas suas agendas...");
  const achados = await coletarEventosPre(90);
  if (achados.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, "Nenhuma reserva com 'pré' encontrada nos próximos 90 dias.");
    return;
  }

  // separa por telefone: mesmo número = mesmo cliente (agrupa)
  const grupos = {};      // telefone -> lista de {ev, calId}
  const semTelefone = []; // sem número: ficam separados

  for (const item of achados) {
    const tel = extrairTelefone((item.ev.summary || "") + " " + (item.ev.description || ""));
    if (tel) {
      if (!grupos[tel]) grupos[tel] = [];
      grupos[tel].push(item);
    } else {
      semTelefone.push(item);
    }
  }

  const totalClientes = Object.keys(grupos).length + semTelefone.length;
  await sendMessage(ADMIN_CHAT_ID, `Encontrei ${achados.length} reserva(s) "pré", agrupadas em ${totalClientes} cliente(s). Abaixo, o que eu enviaria a cada um. NADA foi enviado. 👇`);

  // clientes COM telefone (agrupados)
  for (const tel of Object.keys(grupos)) {
    const eventos = grupos[tel];
    const msg = montarMensagemAgrupada(eventos);
    const qtd = eventos.length > 1 ? ` (${eventos.length} datas)` : "";
    const bloco = `━━━━━━━━━━\n📞 ${tel}${qtd}\n\n✉️ Mensagem:\n${msg}`;
    await sendMessage(ADMIN_CHAT_ID, bloco);
  }

  // clientes SEM telefone (separados, um a um)
  for (const { ev, calId } of semTelefone) {
    const msg = montarMensagemAgrupada([{ ev, calId }]);
    const bloco = `━━━━━━━━━━\n📞 ⚠️ SEM telefone — ${ev.summary || "(sem título)"}\n\n✉️ Mensagem:\n${msg}`;
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
      // 📵 lista as reservas "pré" que estão sem telefone
      if (textoMensagem === '!semtelefone') {
        await listarSemTelefone();
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

// =============================
// AGENDADOR — roda o ENSAIO automaticamente todo dia às 8h (fuso de São Paulo)
// =============================
cron.schedule('0 8 * * *', async () => {
  console.log("⏰ Rodando o ensaio automático das 8h...");
  try {
    if (!whatsappConectado) {
      console.log("WhatsApp não conectado, ensaio adiado.");
      return;
    }
    await rodarEnsaioConfirmacoes();
  } catch (e) {
    console.error("Erro no ensaio automático:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT);
