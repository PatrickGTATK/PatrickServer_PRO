// =======================================================================
//  SERVIDOR MULTI-USUÁRIO TIKTOK COMPLETO (100% SEGURO)
//  ✔ Foguete só reage a gift
//  ✔ Outros overlays continuam funcionando normalmente
// =======================================================================

import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import WebcastPushConnection, { SignConfig } from "./tiktok-live-connector/index.js";
import url from "url";

// -----------------------------------------------------------------------
// CONFIGURAÇÕES
// -----------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY;
const WS_SECRET = process.env.WS_SECRET;
const USERS = process.env.USERS?.split(",").map(u => u.trim()).filter(u => u) || [];

const PING_INTERVAL = 25000;

const app = express();
const server = http.createServer(app);

if (SignConfig && API_KEY) {
    SignConfig.apiKey = API_KEY;
    console.log("🔑 API_KEY carregada.");
}

if (!WS_SECRET || WS_SECRET.length < 16) {
    console.error("🚨 WS_SECRET muito curto! Defina um seguro!");
} else {
    console.log("🔒 WS_SECRET OK.");
}

const tiktokConnections = new Map();

// -----------------------------------------------------------------------
// WEBSOCKET com Autenticação
// -----------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", ws => {
    console.log(`🟢 Overlay conectado (${wss.clients.size})`);
    ws.isAlive = true;

    ws.on("pong", () => ws.isAlive = true);

    const pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!ws.isAlive) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
    }, PING_INTERVAL);

    ws.on("close", () => clearInterval(pingTimer));
});

// Envia evento a todos overlays conectados
function broadcast(event) {
    const msg = JSON.stringify(event);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.isAlive) c.send(msg);
    });
}

// Upgrade com autenticação via token
server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);

    if (pathname !== "/tap") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        return socket.destroy();
    }

    if (!query.token || query.token !== WS_SECRET) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, ws => {
        wss.emit("connection", ws, req);
    });
});

// -----------------------------------------------------------------------
// CONEXÃO AO TIKTOK
// -----------------------------------------------------------------------
function connectToTikTok(username) {
    console.log(`🔄 Conectando: ${username}`);

    if (tiktokConnections.has(username)) {
        const old = tiktokConnections.get(username);
        old.removeAllListeners();
        old.disconnect();
        tiktokConnections.delete(username);
    }

    const tiktok = new WebcastPushConnection(username);
    tiktokConnections.set(username, tiktok);

    function reconnect(reason) {
        console.warn(`⚠️ Reconnect [${username}] →`, reason);
        tiktok.removeAllListeners();
        tiktok.disconnect();
        tiktokConnections.delete(username);

        setTimeout(() => connectToTikTok(username), 5000);
    }

    tiktok.connect()
        .then(() => console.log(`🟢 Live conectada: ${username}`))
        .catch(err => reconnect(err));

    tiktok.on("error", err => reconnect(err));
    tiktok.on("disconnect", () => reconnect("disconnect"));
    tiktok.on("disconnected", () => reconnect("server closed"));

    // ===========================================================
    // EVENTOS CORRETOS
    // ===========================================================

    // TAP (likes) — NÃO dispara foguete
    tiktok.on("like", data => {
        broadcast({
            streamer: username,
            type: "tap",
            user: data.uniqueId,
            nickname: data.nickname,
            likes: data.likeCount,
            pfp: data.profilePictureUrl
        });
    });

    // FOLLOW — NÃO dispara foguete
    tiktok.on("follow", data => {
        broadcast({
            streamer: username,
            type: "follow",
            user: data.uniqueId,
            nickname: data.nickname,
            pfp: data.profilePictureUrl
        });
    });

    // GIFT — dispara o foguete
    tiktok.on("gift", data => {
        broadcast({
            streamer: username,
            type: "gift",
            user: data.uniqueId,
            nickname: data.nickname,
            giftName: data.giftName,
            repeatEnd: data.repeatEnd,
            pfp: data.profilePictureUrl
        });
    });

    // JOIN — NÃO dispara foguete
    tiktok.on("member", data => {
        broadcast({
            streamer: username,
            type: "join",
            user: data.uniqueId,
            nickname: data.nickname,
            pfp: data.profilePictureUrl
        });
    });
}

// -----------------------------------------------------------------------
// INICIAR CONEXÕES DO TIKTOK
// -----------------------------------------------------------------------
if (USERS.length > 0) {
    USERS.forEach(u => connectToTikTok(u));
} else {
    console.log("⚠ Nenhum usuário configurado em USERS");
}

// -----------------------------------------------------------------------
// TESTES — FUNCIONAM COM TODOS OVERLAYS
// -----------------------------------------------------------------------
const TEST_PFP = "https://i.imgur.com/0Z8FQmT.png";

app.get("/test-tap", (req, res) => {
    broadcast({ streamer: "tester", type: "tap", user: "AAA", nickname: "TapTester", likes: 1, pfp: TEST_PFP });
    res.send("✔ TAP enviado.");
});

app.get("/test-follow", (req, res) => {
    broadcast({ streamer: "tester", type: "follow", user: "BBB", nickname: "FollowTester", pfp: TEST_PFP });
    res.send("✔ FOLLOW enviado.");
});

app.get("/test-join", (req, res) => {
    broadcast({ streamer: "tester", type: "join", user: "CCC", nickname: "JoinTester", pfp: TEST_PFP });
    res.send("✔ JOIN enviado.");
});

// SOMENTE ESTE dispara o foguete
app.get("/test-gift", (req, res) => {
    broadcast({
        streamer: "tester",
        type: "gift",
        user: "DDD",
        nickname: "GiftTester",
        giftName: "🎁 Test",
        repeatEnd: true,
        pfp: TEST_PFP
    });
    res.send("✔ GIFT enviado.");
});

// -----------------------------------------------------------------------
server.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ONLINE: ${PORT}`);
});
