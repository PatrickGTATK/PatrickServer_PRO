import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import WebcastPushConnection from "./tiktok-live-connector/index.js";
import winston from "winston"; 
import { URLSearchParams } from "url";

// ------------------------------------------------------------
// CONFIGURAÇÃO DO LOGGER (Winston)
// ------------------------------------------------------------
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => 
            `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}${info.token ? ` (Token: ${info.token})` : ''}`
        )
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// ------------------------------------------------------------
// CONFIGURAÇÕES GERAIS E DE AMBIENTE
// ------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const PROXY_URL = process.env.PROXY_URL || null; 
const WS_SECRET = process.env.WS_SECRET || "123";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin_secret_padrao_mude_isso";

const BASE_RECONNECT_DELAY_SECONDS = 15;
const MAX_BACKOFF_DELAY_MINUTES = 60;
const MAX_CONSECUTIVE_FAILURES = 10;

const MAX_PROXY_FAILURES = 5;
const PROXY_FALLBACK_DELAY_MINUTES = 15;

const HEARTBEAT_INTERVAL = 30000;
const NO_PONG_TIMEOUT = 10000;

// ------------------------------------------------------------
// CARREGAR USUÁRIOS
// ------------------------------------------------------------
let USERS = [];
const USERS_JSON_STRING = process.env.USERS_JSON;

if (USERS_JSON_STRING) {
    try {
        USERS = JSON.parse(USERS_JSON_STRING);
        if (!Array.isArray(USERS)) throw new Error("USERS_JSON não é array.");
        logger.info(`USERS_JSON carregado: ${USERS.length} usuários.`);
    } catch (e) {
        logger.error(`ERRO ao processar USERS_JSON: ${e.message}`);
        process.exit(1);
    }
} else {
    logger.warn("USERS_JSON não configurado. Sem conexões TikTok.");
}

const tiktokConnections = new Map();
const wsClients = new Map();
const connectionMetrics = new Map();

const app = express();
const server = http.createServer(app);

// ------------------------------------------------------------
// HEARTBEAT WEBSOCKET
// ------------------------------------------------------------
function noop() {}
function heartbeat() { this.isAlive = true; }

const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping(noop);
        }
    });
}, HEARTBEAT_INTERVAL);

server.on("close", () => clearInterval(pingInterval));

// ------------------------------------------------------------
// CÁLCULO DO BACKOFF
// ------------------------------------------------------------
function calculateBackoffDelay(metrics) {
    if (metrics.usingDirect) return PROXY_FALLBACK_DELAY_MINUTES * 60;

    if (metrics.failures >= MAX_CONSECUTIVE_FAILURES)
        return MAX_BACKOFF_DELAY_MINUTES * 60;

    return Math.min(
        BASE_RECONNECT_DELAY_SECONDS * Math.pow(2, metrics.failures),
        MAX_BACKOFF_DELAY_MINUTES * 60
    );
}

// ------------------------------------------------------------
// FUNÇÃO PRINCIPAL DE CONEXÃO TIKTOK
// ------------------------------------------------------------
async function createTikTokConnection(token, tiktokUser) {
    const metrics = connectionMetrics.get(token) || {
        failures: 0,
        nextAttempt: 0,
        isPaused: false,
        lastSuccess: 0,
        proxyFailures: 0,
        usingDirect: false
    };
    connectionMetrics.set(token, metrics);

    if (metrics.isPaused) {
        logger.warn(`Conexão @${tiktokUser} pausada.`, { token });
        return;
    }

    let proxyOption = PROXY_URL || undefined;
    if (metrics.usingDirect) proxyOption = undefined;

    logger.info(`Conectando TikTok: @${tiktokUser}`, { token });

    const client = new WebcastPushConnection(tiktokUser, {
        processInitialData: true,
        enableWebsocket: true,
        proxy: proxyOption
    });

    // ------ EVENTOS DE CONTROLE ------
    client.on("disconnected", () => {
        let delay;
        let msg;

        if (proxyOption && !metrics.usingDirect) {
            metrics.proxyFailures++;
            if (metrics.proxyFailures >= MAX_PROXY_FAILURES) {
                metrics.usingDirect = true;
                metrics.failures = 0;
                delay = BASE_RECONNECT_DELAY_SECONDS;
                msg = "Proxy falhou várias vezes. Usando fallback direto.";
            }
        } else if (metrics.usingDirect) {
            metrics.usingDirect = false;
            metrics.proxyFailures = 0;
            metrics.failures++;
            delay = PROXY_FALLBACK_DELAY_MINUTES * 60;
            msg = "Fallback falhou. Voltando ao proxy.";
        }

        if (!msg) {
            metrics.failures++;
            delay = calculateBackoffDelay(metrics);
            msg = `Desconectado. Tentando novamente em ${delay}s.`;
        }

        metrics.nextAttempt = Date.now() + delay * 1000;
        logger.warn(msg, { token });

        tiktokConnections.delete(token);
        client.removeAllListeners();

        setTimeout(() => createTikTokConnection(token, tiktokUser), delay * 1000);
        sendToToken(token, { type: "system", data: { status: "disconnected", reconnectingIn: delay } });
    });

    client.on("error", err => {
        logger.error(`Erro @${tiktokUser}: ${err.message}`, { token });
    });

    // ------ TENTAR CONECTAR ------
    try {
        await client.connect();
        logger.info(`Conectado @${tiktokUser}`, { token });

        metrics.failures = 0;
        metrics.proxyFailures = 0;
        metrics.usingDirect = false;
        metrics.lastSuccess = Date.now();

        connectionMetrics.set(token, metrics);
        tiktokConnections.set(token, client);

        // Eventos TikTok
        const events = ["chat", "gift", "like", "follow", "share", "viewer"];
        events.forEach(evt =>
            client.on(evt, msg => sendToToken(token, { type: evt, data: msg }))
        );

    } catch (err) {
        logger.error(`Falha ao conectar @${tiktokUser}`, { token });
        client.disconnect();
    }
}

// ------------------------------------------------------------
// ENVIO PARA OVERLAYS
// ------------------------------------------------------------
function sendToToken(token, payload) {
    const clients = wsClients.get(token);
    if (!clients) return;
    for (const ws of clients)
        if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(payload));
}

// ------------------------------------------------------------
// INICIAR TODAS AS CONEXÕES TIKTOK
// ------------------------------------------------------------
async function startAllConnections() {
    for (const user of USERS) {
        if (user.active !== true) continue;
        connectionMetrics.set(user.token, {
            failures: 0,
            nextAttempt: 0,
            isPaused: false,
            lastSuccess: 0,
            proxyFailures: 0,
            usingDirect: false
        });
        await createTikTokConnection(user.token, user.tiktokUser);
    }
}
startAllConnections();

// ------------------------------------------------------------
// AUTENTICAÇÃO ADMIN
// ------------------------------------------------------------
function authenticateAdmin(req, res, next) {
    if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
        return res.status(401).send("Acesso não autorizado.");
    next();
}

// ------------------------------------------------------------
// ROTAS HTTP
// ------------------------------------------------------------
app.get("/", (_, res) => {
    res.send("🟢 PatrickServer_PRO — ONLINE");
});

// --------- ROTA WEBHOOK EULER (AQUI ESTÁ O QUE VOCÊ PEDIU!) ---------
app.post("/webhook", express.json(), (req, res) => {
    logger.info("📩 Webhook Euler recebido.");

    const payload = req.body;

    // Enviar para TODOS os tokens ativos
    USERS.forEach(user => {
        if (user.active === true) {
            sendToToken(user.token, {
                type: "euler",
                data: payload
            });
        }
    });

    res.status(200).send("OK");
});

// Status (protegido)
app.get("/status", authenticateAdmin, (req, res) => {
    res.json({
        server: "ONLINE",
        totalUsers: USERS.length,
        wsClients: wss.clients.size
    });
});

// Overlays públicos
app.use("/overlay", express.static("./overlay"));

// ------------------------------------------------------------
// WEBSOCKET OVERLAYS
// ------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", heartbeat);

    const params = new URLSearchParams(req.url.replace("/ws?", ""));
    const token = params.get("token");
    const secret = params.get("secret");

    if (secret !== WS_SECRET) return ws.close();
    if (!token) return ws.close();

    const user = USERS.find(u => u.token === token && u.active === true);
    if (!user) return ws.close();

    if (!wsClients.has(token)) wsClients.set(token, new Set());
    wsClients.get(token).add(ws);

    logger.info(`Overlay conectado (${token})`);

    ws.on("close", () => {
        wsClients.get(token)?.delete(ws);
        if (wsClients.get(token)?.size === 0) {
            logger.warn(`Nenhum overlay ativo. Pausando TikTok ${user.tiktokUser}.`);
            tiktokConnections.get(token)?.disconnect();
            connectionMetrics.get(token).isPaused = true;
        }
    });
});

// ------------------------------------------------------------
// INICIAR SERVIDOR
// ------------------------------------------------------------
server.listen(PORT, () => {
    logger.info(`PatrickServer_PRO iniciado na porta ${PORT}`);
});
