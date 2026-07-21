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

// Números autorizados a AGENDAR (admin + estúdio). Podem ser definidos na env AGENDADORES (separados por vírgula).
const AGENDADORES = (process.env.AGENDADORES || "186564957212720@lid")
  .split(",").map(s => s.trim()).filter(Boolean);
// o admin também sempre pode agendar
function podeAgendar(chatId) {
  return chatId === ADMIN_CHAT_ID || AGENDADORES.includes(chatId);
}

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

// pausa (em milissegundos) — usada para espaçar o envio de várias mensagens
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  // troca barras, asteriscos e outros símbolos por espaço e limpa
  t = t.replace(/[\/*#.\-–]/g, " ").replace(/\s+/g, " ").trim();
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

// procura eventos marcados como "pré" nas agendas de COBRANÇA
// (ignora a agenda de Cancelados, que é a 3ª em CALENDAR_IDS)
async function coletarEventosPre(diasFrente = 90) {
  const agora = new Date();
  const limite = new Date(agora.getTime() + diasFrente * 24 * 60 * 60 * 1000);
  let achados = [];
  // só as duas primeiras agendas (Aclimação e Bela Vista). A 3ª (Cancelados) é ignorada.
  const agendasCobranca = CALENDAR_IDS.slice(0, 2);
  for (const calId of agendasCobranca) {
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

// busca reservas "pré" cujo nome/descrição contém o texto pesquisado
async function buscarPorNome(termo) {
  const alvo = normalizar(termo);
  const achados = await coletarEventosPre(90);
  const encontrados = achados.filter(({ ev }) => {
    const texto = normalizar((ev.summary || "") + " " + (ev.description || ""));
    return texto.includes(alvo);
  });
  if (encontrados.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, `🔍 Nenhuma reserva "pré" encontrada para "${termo}".`);
    return;
  }
  let msg = `🔍 ${encontrados.length} reserva(s) para "${termo}":\n`;
  for (const { ev } of encontrados) {
    const inicio = new Date(ev.start.dateTime || ev.start.date);
    const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'short', day: '2-digit', month: '2-digit' });
    const hora = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    const est = extrairEstudio(ev);
    msg += `\n━━━━━━\n📌 ${ev.summary || "(sem título)"}\n🗓️ ${data} às ${hora}${est ? ` · Estúdio ${est}` : ""}\n📞 ${tel || "⚠️ SEM telefone"}`;
  }
  await sendMessage(ADMIN_CHAT_ID, msg);
}

// conta quantas vezes já foi cobrado, lendo as marcas na descrição
function contarAvisos(ev) {
  const desc = ev.description || "";
  const matches = desc.match(/\[cobrado \d+x/gi);
  return matches ? matches.length : 0;
}

// acrescenta a marca de cobrança na descrição do evento (sem apagar nada)
async function marcarCobranca(ev, calId, numeroAviso) {
  try {
    const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const novaDesc = (ev.description || "") + `\n[cobrado ${numeroAviso}x - ${hoje}]`;
    await calendar.events.patch({
      calendarId: calId,
      eventId: ev.id,
      requestBody: { description: novaDesc },
    });
    return true;
  } catch (e) {
    console.error("Erro ao marcar cobrança no evento", ev.id, e.message);
    return false;
  }
}

// monta a mensagem de cancelamento que seria enviada ao cliente (reserva liberada)
function montarMensagemCancelamento(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const est = extrairEstudio(ev);
  const textoEst = est ? `, no Estúdio ${est}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome},` : "Olá,";
  return `${saudacao} como não recebemos a confirmação, sua reserva de ${dataExtenso}, das ${hi} às ${hf}${textoEst}, foi liberada. 😊\nSe ainda tiver interesse, é só nos chamar que verificamos a disponibilidade!`;
}

// roda o ensaio. Se marcar=true, escreve [cobrado Nx] na descrição (só no automático das 8h)
async function rodarEnsaioConfirmacoes(marcar = false) {
  await sendMessage(ADMIN_CHAT_ID, `🧪 MODO ENSAIO${marcar ? " (automático)" : ""}: procurando reservas 'pré'...`);
  const achados = await coletarEventosPre(90);
  if (achados.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, "Nenhuma reserva com 'pré' encontrada nos próximos 90 dias.");
    return;
  }

  // separa por estágio de aviso
  const paraCobrar = [];       // 0 ou 1 aviso -> cobra
  const paraCancelar = [];     // 2 avisos -> ensaio de cancelamento
  for (const item of achados) {
    if (contarAvisos(item.ev) >= 2) paraCancelar.push(item);
    else paraCobrar.push(item);
  }

  if (paraCobrar.length === 0 && paraCancelar.length === 0) {
    await sendMessage(ADMIN_CHAT_ID, "Nenhuma reserva a processar hoje.");
    return;
  }

  // agrupa por telefone: mesmo número = mesmo cliente
  const grupos = {};
  const semTelefone = [];
  for (const item of paraCobrar) {
    const tel = extrairTelefone((item.ev.summary || "") + " " + (item.ev.description || ""));
    if (tel) { (grupos[tel] = grupos[tel] || []).push(item); }
    else semTelefone.push(item);
  }

  const totalClientes = Object.keys(grupos).length + semTelefone.length;
  await sendMessage(ADMIN_CHAT_ID, `Encontrei ${paraCobrar.length} reserva(s) a cobrar, agrupadas em ${totalClientes} cliente(s). NADA foi enviado ao cliente. 👇`);

  let marc1 = 0, marc2 = 0;

  // marca uma lista de eventos (só se marcar=true)
  async function marcarLista(eventos) {
    if (!marcar) return;
    for (const { ev, calId } of eventos) {
      const proximo = contarAvisos(ev) + 1;
      const ok = await marcarCobranca(ev, calId, proximo);
      if (ok) { if (proximo === 1) marc1++; else marc2++; }
    }
  }

  // clientes COM telefone (agrupados)
  for (const tel of Object.keys(grupos)) {
    const eventos = grupos[tel];
    try {
      const msg = montarMensagemAgrupada(eventos);
      const qtd = eventos.length > 1 ? ` (${eventos.length} datas)` : "";
      await sendMessage(ADMIN_CHAT_ID, `━━━━━━━━━━\n📞 ${tel}${qtd}\n\n✉️ Mensagem:\n${msg}`);
    } catch (e) {
      await sendMessage(ADMIN_CHAT_ID, `⚠️ Erro ao processar o cliente ${tel}: ${e.message}`);
    }
    await marcarLista(eventos);
    await esperar(3000);
  }

  // clientes SEM telefone (separados, um a um)
  for (const item of semTelefone) {
    try {
      const msg = montarMensagemAgrupada([item]);
      await sendMessage(ADMIN_CHAT_ID, `━━━━━━━━━━\n📞 ⚠️ SEM telefone — ${item.ev.summary || "(sem título)"}\n\n✉️ Mensagem:\n${msg}`);
    } catch (e) {
      await sendMessage(ADMIN_CHAT_ID, `⚠️ Erro ao processar "${item.ev.summary || "(sem título)"}": ${e.message}`);
    }
    await marcarLista([item]);
    await esperar(3000);
  }

  // ENSAIO DE CANCELAMENTO — reservas com 2 avisos (3º dia). Só simula, não faz nada.
  for (const { ev, calId } of paraCancelar) {
    try {
      const msgCliente = montarMensagemCancelamento(ev, calId);
      const bloco =
        `🛑 ENSAIO — CANCELAMENTO\n📌 ${ev.summary || "(sem título)"}\n\n` +
        `Esta reserva atingiu 2 avisos. Agora eu:\n` +
        `1️⃣ Enviaria esta mensagem ao cliente:\n"${msgCliente}"\n\n` +
        `2️⃣ Moveria o evento para a agenda Cancelados.\n\n` +
        `(Nada foi feito — apenas simulação.)`;
      await sendMessage(ADMIN_CHAT_ID, bloco);
    } catch (e) {
      await sendMessage(ADMIN_CHAT_ID, `⚠️ Erro no cancelamento de "${ev.summary || "(sem título)"}": ${e.message}`);
    }
    await esperar(3000);
  }

  const resumoMarca = marcar
    ? `\n📌 ${marc1} marcada(s) como 1ª cobrança\n📌 ${marc2} marcada(s) como 2ª cobrança`
    : "\n(Modo teste: nada foi marcado na agenda.)";
  const resumoCancel = paraCancelar.length
    ? `\n🛑 ${paraCancelar.length} reserva(s) no estágio de cancelamento (simulado).`
    : "";
  await sendMessage(ADMIN_CHAT_ID, `✅ Fim do ensaio.${resumoMarca}${resumoCancel}`);
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
// AGENDAMENTO (!agendar) — cria evento na agenda certa
// =============================

// guarda agendamentos aguardando confirmação (por chatId)
const agendamentosPendentes = {};

// mapa estúdio -> qual agenda (índice em CALENDAR_IDS): Aclimação=0, Bela Vista=1
function agendaDoEstudio(est) {
  const aclimacao = ["A", "B", "C", "D", "AB"];
  const belavista = ["1", "2", "3"];
  if (aclimacao.includes(est)) return { calId: CALENDAR_IDS[0], unidade: "Aclimação" };
  if (belavista.includes(est)) return { calId: CALENDAR_IDS[1], unidade: "Bela Vista" };
  return null;
}

// interpreta o texto do comando !agendar
// formato: !agendar DD/MM HH-HH ESTUDIO NOME TELEFONE [pago VALOR]
function interpretarAgendamento(texto) {
  // tira o "!agendar" do começo
  let resto = texto.replace(/^!agendar\s+/i, "").trim();

  // captura "pago VALOR" no fim, se houver
  let pago = null;
  const mPago = resto.match(/\s+pago\s+r?\$?\s*([\d.,]+)\s*$/i);
  if (mPago) {
    pago = mPago[1].replace(",", ".");
    resto = resto.slice(0, mPago.index).trim();
  }

  const partes = resto.split(/\s+/);
  if (partes.length < 4) return { erro: "Faltam informações. Use: !agendar DD/MM HH-HH ESTUDIO NOME TELEFONE" };

  const dataStr = partes[0];             // DD/MM
  const horaStr = partes[1];             // HH-HH
  const estudio = partes[2].toUpperCase(); // A, B, C, D, AB, 1, 2, 3

  // telefone = última parte se for número; nome = o que está no meio
  let telefone = null;
  let nomeParts = partes.slice(3);
  const ultima = nomeParts[nomeParts.length - 1];
  if (/\d{4,}/.test(ultima)) {
    telefone = ultima.replace(/\D/g, "");
    nomeParts = nomeParts.slice(0, -1);
  }
  const nome = nomeParts.join(" ").trim();

  // valida data DD/MM
  const md = dataStr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!md) return { erro: `Data inválida: "${dataStr}". Use DD/MM (ex.: 25/07).` };
  const dia = parseInt(md[1]), mes = parseInt(md[2]);

  // valida horário HH-HH
  const mh = horaStr.match(/^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/);
  if (!mh) return { erro: `Horário inválido: "${horaStr}". Use HH-HH (ex.: 14-16 ou 14:30-16:30).` };
  const h1 = parseInt(mh[1]), m1 = parseInt(mh[2] || "0");
  const h2 = parseInt(mh[3]), m2 = parseInt(mh[4] || "0");

  // valida estúdio
  const ag = agendaDoEstudio(estudio);
  if (!ag) return { erro: `Estúdio inválido: "${estudio}". Use A, B, C, D, AB (Aclimação) ou 1, 2, 3 (Bela Vista).` };

  if (!nome) return { erro: "Faltou o nome do cliente." };

  // monta as datas (ano atual; se o mês já passou, assume próximo ano)
  const agora = new Date();
  let ano = agora.getFullYear();
  const inicio = new Date(ano, mes - 1, dia, h1, m1);
  if (inicio < agora && (agora - inicio) > 7 * 24 * 3600 * 1000) {
    // se a data ficou muito no passado, provavelmente é ano que vem
    inicio.setFullYear(ano + 1);
  }
  const fim = new Date(inicio);
  fim.setHours(h2, m2);

  return { dia, mes, estudio, nome, telefone, pago, inicio, fim, ...ag };
}

// checa se o estúdio já está ocupado no horário (nas agendas de cobrança)
async function horarioOcupado(calId, estudio, inicio, fim) {
  try {
    const res = await calendar.events.list({
      calendarId: calId,
      timeMin: new Date(inicio.getTime() - 60000).toISOString(),
      timeMax: new Date(fim.getTime() + 60000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    for (const ev of (res.data.items || [])) {
      if (extrairEstudio(ev) === estudio) {
        const ei = new Date(ev.start.dateTime || ev.start.date);
        const ef = new Date(ev.end.dateTime || ev.end.date);
        // há sobreposição?
        if (inicio < ef && fim > ei) return ev;
      }
    }
    return null;
  } catch (e) {
    console.error("Erro ao checar conflito:", e.message);
    return null;
  }
}

// cria o evento de verdade na agenda
async function criarEvento(dados) {
  const titulo = `${dados.inicio.getHours()}-${dados.fim.getHours()}/${dados.estudio}${dados.pago ? "" : " pré"}`;
  let descricao = dados.nome;
  if (dados.telefone) descricao += ` ${dados.telefone}`;
  if (dados.pago) descricao += `\npago R$${dados.pago}`;
  await calendar.events.insert({
    calendarId: dados.calId,
    requestBody: {
      summary: titulo,
      description: descricao,
      start: { dateTime: dados.inicio.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: dados.fim.toISOString(), timeZone: "America/Sao_Paulo" },
    },
  });
  return titulo;
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

    // 📅 AGENDAMENTO — quem pode agendar (admin + estúdio)
    if (podeAgendar(chatId)) {
      // confirmação de um agendamento pendente
      if (textoMensagem === 'sim' && agendamentosPendentes[chatId]) {
        const dados = agendamentosPendentes[chatId];
        delete agendamentosPendentes[chatId];
        try {
          const titulo = await criarEvento(dados);
          await sendMessage(chatId, `✅ Agendado com sucesso!\n📌 ${titulo}\n📍 ${dados.unidade}\n👤 ${dados.nome}${dados.telefone ? " · " + dados.telefone : ""}${dados.pago ? `\n💰 pago R$${dados.pago}` : "\n(pré-reserva)"}`);
        } catch (e) {
          await sendMessage(chatId, `❌ Erro ao criar o evento: ${e.message}`);
        }
        return;
      }
      if (textoMensagem === 'nao' || textoMensagem === 'não') {
        if (agendamentosPendentes[chatId]) {
          delete agendamentosPendentes[chatId];
          await sendMessage(chatId, "Ok, agendamento cancelado. 👍");
          return;
        }
      }

      if (textoMensagem.startsWith('!agendar')) {
        const dados = interpretarAgendamento(msg.body.trim());
        if (dados.erro) {
          await sendMessage(chatId, `⚠️ ${dados.erro}`);
          return;
        }
        // checa conflito de horário
        const conflito = await horarioOcupado(dados.calId, dados.estudio, dados.inicio, dados.fim);
        if (conflito) {
          const ci = new Date(conflito.start.dateTime || conflito.start.date);
          const cf = new Date(conflito.end.dateTime || conflito.end.date);
          const hi = ci.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
          const hf = cf.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
          await sendMessage(chatId, `❌ Esse estúdio já está ocupado nesse horário!\nJá existe: "${conflito.summary}" das ${hi} às ${hf}.\n\nNão agendei nada. Verifique.`);
          return;
        }
        // guarda como pendente e pede confirmação
        agendamentosPendentes[chatId] = dados;
        const dataFmt = dados.inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
        const hi = dados.inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
        const hf = dados.fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
        await sendMessage(chatId,
          `📋 Confirma este agendamento?\n\n` +
          `📅 ${dataFmt}\n🕐 ${hi} às ${hf}\n📸 Estúdio ${dados.estudio} (${dados.unidade})\n👤 ${dados.nome}\n📞 ${dados.telefone || "⚠️ sem telefone"}\n${dados.pago ? `💰 pago R$${dados.pago}` : "🔖 pré-reserva"}\n\n` +
          `Responda *SIM* para confirmar ou *NÃO* para cancelar.`
        );
        return;
      }
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
      // 🔍 busca reservas por nome do cliente. Ex.: !buscar new star
      if (textoMensagem.startsWith('!buscar')) {
        const termo = msg.body.trim().slice(7).trim(); // texto depois de "!buscar"
        if (!termo) {
          await sendMessage(ADMIN_CHAT_ID, "Escreva o nome depois do comando. Ex.: !buscar new star");
        } else {
          await buscarPorNome(termo);
        }
        return;
      }
      // ❓ lista os comandos disponíveis
      if (textoMensagem === '!ajuda') {
        await sendMessage(ADMIN_CHAT_ID,
          "🤖 *Comandos disponíveis:*\n\n" +
          "!testar — mostra as cobranças (modo ensaio)\n" +
          "!semtelefone — lista reservas sem telefone\n" +
          "!buscar [nome] — busca reservas de um cliente\n" +
          "!agenda — mostra a agenda dos próximos 15 dias\n" +
          "!status — diz se o respondedor está ligado\n" +
          "!ativar / !desativar — liga/desliga o respondedor\n" +
          "!meuid — mostra seu ID"
        );
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
    await rodarEnsaioConfirmacoes(true); // automático das 8h: marca [cobrado Nx] na agenda
  } catch (e) {
    console.error("Erro no ensaio automático:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT);
