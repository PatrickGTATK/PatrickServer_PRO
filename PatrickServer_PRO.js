import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import winston from "winston";

// ------------------------------------------------------------
// LOGGER
// ------------------------------------------------------------
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [new winston.transports.Console()]
});

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const WS_SECRET = process.env.WS_SECRET || "123";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";

// ------------------------------------------------------------
// EXPRESS / HTTP
// ------------------------------------------------------------
const app = express();
const server = http.createServer(app);

app.use(express.json()); // necessário p/ Webhook Euler

// ------------------------------------------------------------
// WEBSOCKETS
// ------------------------------------------------------------
const wsClients = new Map(); // token -> Set(clients)

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const secret = url.searchParams.get("secret");

    if (!token || secret !== WS_SECRET) {
        ws.close();
        return;
    }

    if (!wsClients.has(token)) wsClients.set(token, new Set());
    wsClients.get(token).add(ws);

    logger.info(`Overlay conectado (token=${token})`);

    ws.on("close", () => {
        wsClients.get(token)?.delete(ws);
        logger.info(`Overlay desconectado (token=${token})`);
    });
});

// Enviar evento aos overlays daquele token
function sendToToken(token, payload) {
    const clients = wsClients.get(token);
    if (!clients) return;

    const json = JSON.stringify(payload);
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
}

// ------------------------------------------------------------
// 🔥 WEBHOOK DO EULER STREAM (AQUI CHEGA OS EVENTOS)
// ------------------------------------------------------------
app.post("/webhook", (req, res) => {
    const event = req.body;

    logger.info(`Evento recebido do Euler: ${event?.event || "desconhecido"}`);

    // Euler manda { token: "...", event: "...", data: {...} }
    if (!event?.token) {
        logger.warn("Webhook recebido SEM token! Ignorando.");
        return res.status(400).send("Faltando token.");
    }

    // Enviar o evento direto pro overlay daquele token
    sendToToken(event.token, {
        type: event.event,
        data: event.data
    });

    res.send("OK");
});

// ------------------------------------------------------------
// ROTA STATUS (PROTEGIDA)
// ------------------------------------------------------------
app.get("/status", (req, res) => {
    if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
        return res.status(401).send("Não autorizado.");

    res.json({
        server: "ONLINE",
        overlaysAtivos: wsClients.size
    });
});

// ------------------------------------------------------------
// ROTA SIMPLES
// ------------------------------------------------------------
app.get("/", (req, res) => {
    res.send("🟢 PatrickServer_PRO (Modo EulerStream) — ONLINE");
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
server.listen(PORT, () => {
    logger.info(`🚀 PatrickServer_PRO rodando na porta ${PORT}`);
});
