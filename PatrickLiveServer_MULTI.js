// =======================================================================
//  SERVIDOR MULTI-USUÁRIO TIKTOK — 100% CORRIGIDO PARA O TESTE FOLLOW
// =======================================================================

import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import WebcastPushConnection, { SignConfig } from "./tiktok-live-connector/index.js";
import url from "url";

// -----------------------------------------------------------------------
// CONFIGS
// -----------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const WS_SECRET = process.env.WS_SECRET;
const API_KEY = process.env.API_KEY;
const USERS = process.env.USERS?.split(",") || [];
const PING_INTERVAL = 25000;

const app = express();
const server = http.createServer(app);

// TikTok API KEY
if (SignConfig && API_KEY) {
    SignConfig.apiKey = API_KEY;
}

// -----------------------------------------------------------------------
// WEBSOCKET COM AUTENTICAÇÃO
// -----------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", ws => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);

    const timer = setInterval(() => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    }, PING_INTERVAL);

    ws.on("close", () => clearInterval(timer));
});

// FUNÇÃO PARA ENVIAR EVENTOS AO OVERLAY
function broadcast(event) {
    const msg = JSON.stringify(event);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

// AUTENTICAÇÃO POR TOKEN
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
// EVENTO TESTE FOLLOW — AGORA ENVIA O PACOTE CERTO!
// -----------------------------------------------------------------------
const TEST_PFP = "https://i.imgur.com/0Z8FQmT.png";

app.get("/test-follow", (req, res) => {
    broadcast({
        type: "follow",
        nickname: "FollowTester",
        user: "tester123",
        pfp: TEST_PFP
    });

    res.send("✔ FOLLOW ENVIADO PARA O OVERLAY!");
});

// -----------------------------------------------------------------------
// TIKTOK
// -----------------------------------------------------------------------
function connectToTikTok(username) {
    const conn = new WebcastPushConnection(username);

    conn.connect()
        .then(() => console.log("🟢 conectado:", username))
        .catch(err => console.log("erro:", err));

    conn.on("follow", data => {
        broadcast({
            type: "follow",
            nickname: data.nickname,
            user: data.uniqueId,
            pfp: data.profilePictureUrl
        });
    });
}

USERS.forEach(u => connectToTikTok(u));

// -----------------------------------------------------------------------
server.listen(PORT, () => {
    console.log(`🚀 SERVIDOR PRONTO — PORTA ${PORT}`);
    console.log("Teste Follow → /test-follow");
});
