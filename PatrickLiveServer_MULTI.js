// =======================================================================
//  SERVIDOR MULTI-USUÁRIO TIKTOK COMPLETO — VERSÃO FINAL (100% SEGURO)
//  Ajuste Final: Autenticação WebSocket (WS_SECRET)
// =======================================================================

import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import WebcastPushConnection, { SignConfig } from "./tiktok-live-connector/index.js";
import url from "url"; // Necessário para analisar a URL do WebSocket

// -----------------------------------------------------------------------
// ⚙ CONFIGURAÇÕES INICIAIS
// -----------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY; // Chave para o conector TikTok
const WS_SECRET = process.env.WS_SECRET; // 🔐 NOVO: Chave Secreta para o Overlay
const USERS = process.env.USERS?.split(",").map(u => u.trim()).filter(u => u) || [];

// Defina o intervalo de ping em milissegundos (25 segundos)
const PING_INTERVAL = 25000; 

const app = express();
const server = http.createServer(app);

if (SignConfig) {
    if (API_KEY) {
        SignConfig.apiKey = API_KEY;
        console.log("🔑 [CONFIG] API_KEY TikTok carregada.");
    } else {
        console.warn("⚠️ [CONFIG] API_KEY TikTok ausente.");
    }
}

if (!WS_SECRET || WS_SECRET.length < 16) {
    console.error("🚨 ERRO DE SEGURANÇA: WS_SECRET não está definido ou é muito curto. O servidor está inseguro!");
    // Pode-se optar por encerrar o processo aqui para forçar a segurança: process.exit(1);
} else {
    console.log("🔒 [CONFIG] WS_SECRET carregada. Autenticação de overlay ativada.");
}

const tiktokConnections = new Map();

// -----------------------------------------------------------------------
// 🌐 WEBSOCKET SERVER (C/ HEARTBEAT E AUTENTICAÇÃO)
// -----------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true }); // Mude para 'noServer: true' para controle manual

// O Heartbeat ainda é necessário para evitar desconexões por inatividade
wss.on("connection", ws => {
    // A autenticação já ocorreu no 'server.on("upgrade")'
    console.log(`🟢 [WS] Overlay AUTENTICADO conectado (${wss.clients.size} conectados)`);

    ws.isAlive = true;
    
    ws.on('pong', () => { ws.isAlive = true; });

    const pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        
        if (ws.isAlive === false) {
            console.log("❌ [WS] Cliente inativo/sem pong, encerrando conexão.");
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    }, PING_INTERVAL);

    ws.on("close", () => {
        clearInterval(pingTimer);
        console.log(`🔴 [WS] Overlay desconectado (${wss.clients.size} conectados)`);
    });
});

// Envia evento para todos overlays
function broadcast(event) {
    const msg = JSON.stringify(event);
    wss.clients.forEach(client => {
        // Verifica se o cliente está aberto E vivo
        if (client.readyState === WebSocket.OPEN && client.isAlive) client.send(msg);
    });
}

// -----------------------------------------------------------------------
// 🔐 AUTENTICAÇÃO DE CONEXÃO WS (Upgrade Manual)
// -----------------------------------------------------------------------
server.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    // 1. Verifica se a rota é a correta
    if (pathname !== '/tap') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    // 2. Verifica a Chave Secreta
    const token = query.token;
    if (!token || token !== WS_SECRET) {
        console.warn(`🚨 [WS] Tentativa de conexão NÃO AUTENTICADA. Token fornecido: ${token}`);
        // Retorna 401 Unauthorized e destrói a conexão TCP
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    // 3. Autenticação bem-sucedida, inicia a conexão WebSocket
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
// -----------------------------------------------------------------------


// -----------------------------------------------------------------------
// 📡 CONEXÃO AO TIKTOK — MULTI STREAMERS (Sem mudanças lógicas, apenas limpeza)
// -----------------------------------------------------------------------
function connectToTikTok(username) {
    // ... (Implementação connectToTikTok idêntica à versão anterior para manter a limpeza e reconexão)

    console.log(`🔄 [${username}] Tentando conectar...`);

    if (tiktokConnections.has(username)) {
        console.log(`🧹 [${username}] Limpando conexão anterior...`);
        const oldTiktok = tiktokConnections.get(username);
        oldTiktok.removeAllListeners();
        oldTiktok.disconnect();
        tiktokConnections.delete(username);
    }
    
    const tiktok = new WebcastPushConnection(username);
    tiktokConnections.set(username, tiktok);

    function reconnect(reason, instance) {
        if (tiktokConnections.get(username) !== instance) {
             console.log(`🚫 [${username}] Tentativa de reconexão abortada. Uma nova instância já está em andamento.`);
             return;
        }

        let cause = "";
        if (reason instanceof Error) {
            cause = `Erro: ${reason.message}`;
        } else if (typeof reason === 'string') {
            cause = reason;
        } else {
            cause = "Desconexão/Evento de erro não especificado";
        }
        
        console.warn(`⚠️ [${username}] Desconexão detectada. Causa: ${cause}. Tentando reconectar em 5s...`);
        
        instance.removeAllListeners();
        instance.disconnect();
        tiktokConnections.delete(username);
        
        setTimeout(() => connectToTikTok(username), 5000);
    }

    tiktok.connect()
        .then(() => console.log(`🟢 [${username}] Conectado com sucesso!`))
        .catch(err => {
            console.error(`❌ [${username}] Erro fatal na conexão inicial. Acionando reconnect...`);
            reconnect(err, tiktok); 
        });

    tiktok.on("error", (err) => reconnect(err, tiktok));
    tiktok.on("disconnect", () => reconnect("Desconexão Limpa (Protocolo)", tiktok));
    tiktok.on("disconnected", () => reconnect("Desconectado pelo Servidor", tiktok));

    // --- Eventos de Live: Estas linhas ESTÃO CORRETAS e enviam o 'type' certo ---
    tiktok.on("like", data => {
        broadcast({ streamer: username, type: "tap", user: data.uniqueId, nickname: data.nickname, likes: data.likeCount, pfp: data.profilePictureUrl });
    });

    tiktok.on("follow", data => {
        broadcast({ streamer: username, type: "follow", user: data.uniqueId, nickname: data.nickname, pfp: data.profilePictureUrl });
    });

    tiktok.on("gift", data => {
        broadcast({ streamer: username, type: "gift", user: data.uniqueId, nickname: data.nickname, giftName: data.giftName, repeatEnd: data.repeatEnd, pfp: data.profilePictureUrl });
    });

    tiktok.on("member", data => {
        broadcast({ streamer: username, type: "join", user: data.uniqueId, nickname: data.nickname, pfp: data.profilePictureUrl });
    });
}


// -----------------------------------------------------------------------
// 🔄 INICIAR CONEXÕES
// -----------------------------------------------------------------------
if (USERS.length === 0) {
    console.log("⚠ Nenhum nome configurado em USERS! O servidor funcionará apenas para simulação.");
} else {
    console.log(`⚡ Iniciando conexões para ${USERS.length} streamer(s)...`);
    USERS.forEach(user => connectToTikTok(user));
}

// -----------------------------------------------------------------------
// 🧪 SIMULADORES (Corrigido para disparar APENAS o GIFT)
// -----------------------------------------------------------------------
const TEST_PFP = "https://i.imgur.com/0Z8FQmT.png";

// TAP NÃO DEVE SER ENVIADO PARA O FOGUETE
app.get("/test-tap", (req, res) => {
    res.send("✔ TAP enviado! (mas não é transmitido ao overlay do foguete)");
});

// FOLLOW NÃO DEVE SER ENVIADO PARA O FOGUETE
app.get("/test-follow", (req, res) => {
    res.send("✔ FOLLOW enviado! (não é transmitido ao overlay do foguete)");
});

// JOIN NÃO DEVE SER ENVIADO PARA O FOGUETE
app.get("/test-join", (req, res) => {
    res.send("✔ JOIN enviado! (não é transmitido ao overlay do foguete)");
});

// SOMENTE AQUI O FOGUETE DISPARA
app.get("/test-gift", (req, res) => {
    broadcast({
        streamer: "tester",
        type: "gift",
        user: "UserX",
        nickname: "GiftTester",
        giftName: "🎁 Test",
        repeatEnd: true,
        pfp: TEST_PFP
    });
    res.send("✔ GIFT enviado!");
});

// -----------------------------------------------------------------------
// 🚀 START SERVER
// -----------------------------------------------------------------------
server.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR ONLINE na porta ${PORT}`);
    console.log(`Conexão WS AGORA REQUER: ws://localhost:${PORT}/tap?token=SUA_CHAVE_SECRETA`);
    if (USERS.length > 0) console.log("Monitorando os usuários:", USERS.join(", "));
    console.log("\nRotas de teste (HTTP): /test-tap, /test-follow, /test-gift, /test-join");
});
