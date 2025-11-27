import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

// IMPORTAÇÃO REMOTA — SEM NPM, SEM ERRO, MENOS COISA POSSÍVEL
import WebcastPushConnection, { SignConfig } from "./tiktok-live-connector/index.js";

const PORT = process.env.PORT || 8080;

// ======================================================
// 🧠 ARQUITETURA MULTI-USER
// ======================================================
const userSessions = new Map();      
const API_KEYS = (process.env.TIKTOK_API_KEYS || "").split(",").map(s => s.trim());
let apiKeyIndex = 0;

// ======================================================
// Express + HTTP
// ======================================================
const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
    res.send("Patrick Multi-User TikTok Server OK");
});

app.get("/debug", (req, res) => {
    const debug = {};

    for (const [user, session] of userSessions.entries()) {
        debug[user] = {
            tiktokStatus: session.status,
            overlaysTap: session.tapConnections.size,
            overlaysRocket: session.rocketConnections.size
        };
    }

    res.json(debug);
});

// ======================================================
// WebSocket Server
// ======================================================
const wss = new WebSocketServer({ server });

function heartbeat(ws) { ws.isAlive = true; }

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

// ======================================================
// 🔥 SESSÃO POR USUÁRIO
// ======================================================
function createUserSession(username) {
    if (userSessions.has(username)) return userSessions.get(username);

    const session = {
        username,
        tiktok: null,
        tapConnections: new Set(),
        rocketConnections: new Set(),
        queue: [],
        processing: false,
        status: "desconectado",
        retryDelay: 2000,
        reconnecting: false,
        lastEventTime: Date.now(),
        fallbackMode: false,
        apiKeyIndexLocal: apiKeyIndex
    };

    userSessions.set(username, session);
    startTikTokSession(session);

    return session;
}

// ======================================================
// LOGICA DE FILA
// ======================================================
function enqueue(session, fn) {
    session.queue.push(fn);
    processQueue(session);
}

function processQueue(session) {
    if (session.processing) return;
    session.processing = true;

    while (session.queue.length > 0) {
        const fn = session.queue.shift();
        try { fn(); } catch (err) { console.log("ERRO FILA:", err); }
    }

    session.processing = false;
}

// ======================================================
// TIKTOK POR USER
// ======================================================
function startTikTokSession(session) {
    const { username } = session;

    if (session.tiktok) {
        session.tiktok.removeAllListeners();
        session.tiktok.disconnect();
        session.tiktok = null;
    }

    if (SignConfig) {
        SignConfig.apiKey = API_KEYS[session.apiKeyIndexLocal];
    }

    console.log(`\n[${username}] Conectando... (fallback=${session.fallbackMode})`);

    const tiktok = new WebcastPushConnection(username, {
        enableExtendedGiftInfo: true,
        processInitialData: false,
        requestPolling: session.fallbackMode
    });

    session.tiktok = tiktok;

    tiktok.connect().then(state => {
        console.log(`🟢 [${username}] Conectado! RoomID: ${state.roomId}`);
        session.status = "conectado";
        session.retryDelay = 2000;
        session.fallbackMode = false;
        session.lastEventTime = Date.now();

        tiktok.on("like", data => {
            session.lastEventTime = Date.now();
            enqueue(session, () => {
                const msg = JSON.stringify({
                    type: "tap",
                    nickname: data.nickname,
                    pfp: data.profilePictureUrl
                });
                session.tapConnections.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
            });
        });

        tiktok.on("gift", data => {
            session.lastEventTime = Date.now();
            enqueue(session, () => {
                const msg = JSON.stringify({
                    type: "gift",
                    nickname: data.nickname,
                    pfp: data.profilePictureUrl,
                    gift: data.giftName,
                    repeatEnd: data.repeatEnd
                });
                session.rocketConnections.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
            });
        });

        tiktok.on("chat", () => {
            session.lastEventTime = Date.now();
        });

        tiktok.on("disconnected", () => {
            console.log(`🔴 [${username}] Desconectado`);
            triggerReconnect(session);
        });

        tiktok.on("error", err => {
            console.log(`❌ [${username}] ERRO: ${err.message}`);
            session.fallbackMode = !session.fallbackMode;
            triggerReconnect(session);
        });

    }).catch(err => {
        console.log(`❌ [${username}] FALHA: ${err.message}`);
        session.fallbackMode = !session.fallbackMode;
        triggerReconnect(session);
    });
}

function triggerReconnect(session) {
    if (session.reconnecting) return;
    session.reconnecting = true;

    console.log(`[${session.username}] Tentando reconectar em ${session.retryDelay / 1000}s…`);

    setTimeout(() => {
        session.reconnecting = false;
        session.retryDelay = Math.min(session.retryDelay * 2, 30000);
        startTikTokSession(session);
    }, session.retryDelay);
}

// ======================================================
// WEBSOCKET CONNECTION HANDLER
// ======================================================
wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => heartbeat(ws));

    const url = new URL(req.url, "http://localhost");
    const user = url.searchParams.get("user");

    if (!user) {
        ws.close();
        return;
    }

    const session = createUserSession(user);

    if (url.pathname.includes("tap")) {
        session.tapConnections.add(ws);
        console.log(`🟢 Overlay TAP conectado (${user})`);
        ws.on("close", () => session.tapConnections.delete(ws));
    } else if (url.pathname.includes("rocket")) {
        session.rocketConnections.add(ws);
        console.log(`🟢 Overlay ROCKET conectado (${user})`);
        ws.on("close", () => session.rocketConnections.delete(ws));
    }
});

// ======================================================
// START SERVER
// ======================================================
server.listen(PORT, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 MULTI-USER SERVER ON PORT ${PORT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
