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

    // Se o bot estiver pausado globalmente, ignora
    if (!botAtivo) return;

    // 🧠 NOVO FILTRO DE INTERVENÇÃO HUMANA:
    // Puxa o histórico recente para ver quem mandou a última mensagem
    const chat = await msg.getChat();
    const mensagensRecentes = await chat.fetchMessages({ limit: 2 });
    
    // Se você mandou a mensagem anterior à resposta do cliente, o robô recua e não responde
    if (mensagensRecentes.length > 1) {
      const penultimaMsg = mensagensRecentes[0];
      if (penultimaMsg.fromMe) {
        console.log(`🤖 Intervenção detectada em ${chatId}. O admin já está conversando.`);
        return; 
      }
    }

    // Se houver palavras que indicam que você assumiu (Dionísio, Suporte, etc.)
    if (msg.body.toLowerCase().includes('dionísio') || msg.body.toLowerCase().includes('aqui é o dono')) {
      return;
    }

    // Comportamento normal quando ativo e sem intervenção manual
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
