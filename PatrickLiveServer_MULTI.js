// =======================================================================
//  SERVIDOR MULTI-USUÁRIO ULTRA PROTEGIDO (VERSÃO FINAL E DEFINITIVA)
//  ✔ Estrutura: Classe LiveClient (OO)
//  ✔ Heartbeat (Ping/Pong) para limpar overlays inativos.
//  ✔ Cache de PFP com Expiração (TTL) para liberar memória.
//  ✔ LOG AVANÇADO: Usa console.info/warn/error nativos.
// =======================================================================

import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import WebcastPushConnection from "./tiktok-live-connector/index.js";
import url from "url";
import process from "process";

// ------------------------------------------------------------
// CONFIGURAÇÕES GLOBAIS
// ------------------------------------------------------------
const PORT = process.env.PORT; // CORREÇÃO APLICADA: Removido o '|| 8080'
const API_KEY = process.env.API_KEY;
const WS_SECRET = process.env.WS_SECRET;
const USERS = process.env.USERS?.split(",").map(u => u.trim()) || [];

const TAP_THROTTLE_MS = 150; 

// Reconexão (Exponential Backoff)
const BACKOFF_MIN = 2500;
const BACKOFF_MAX = 15000;
const BACKOFF_MULTIPLIER = 1.4;

// Otimização de Memória e WS
const PFP_CACHE_TTL_MS = 3600000; // 1 hora de vida para as entradas do PFP Cache
const HEARTBEAT_INTERVAL_MS = 30000; // Ping a cada 30 segundos

// Headers Stealth (Anti-Bloqueio)
const STEALTH_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Mode": "cors",
};

// Validação de Pré-requisitos
if (!API_KEY) {
    console.error("❌ API_KEY ausente. Configure no Railway.");
    process.exit(1);
}
if (!WS_SECRET) {
    console.error("❌ WS_SECRET ausente. Configure no Railway.");
    process.exit(1);
}
if (USERS.length === 0) {
    console.error("❌ Nenhum usuário configurado. Defina USERS no Railway.");
    process.exit(1);
}

// ------------------------------------------------------------
// APP BASE E WEBSOCKET COM HEARTBEAT
// ------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

// Inicia o processo de Heartbeat
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        // ws.isAlive é definido como true na conexão e no 'pong'
        if (ws.readyState === 1 && ws.isAlive === false) { 
            // Se o cliente não respondeu ao último ping
            console.warn("⚠ WS inativo detectado (Sem PONG). Terminando conexão.");
            return ws.terminate();
        }
        
        // Define isAlive como false e envia PING. Espera PONG.
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on("connection", (ws, req) => {
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    const token = urlParams.searchParams.get("token");

    if (token !== WS_SECRET) {
        ws.close();
        console.warn("Tentativa de conexão WS bloqueada (Token inválido).");
        return;
    }

    // Propriedade para controle do Heartbeat
    ws.isAlive = true; 
    
    // Responde ao PING do servidor
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    console.log("🟢 Overlay conectado (Heartbeat ativo).");
});

wss.on('close', () => {
    clearInterval(interval);
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
        if (ws.readyState === 1) { 
            try {
                ws.send(msg);
            } catch (error) {
                console.warn(`[WARN] Falha ao enviar broadcast: ${error.message}`);
                ws.close();
            }
        }
    }
}

// ------------------------------------------------------------
// CACHE DE FOTO COM EXPIRAÇÃO (TTL)
// ------------------------------------------------------------
// O cache agora armazena { pfpUrl, timestamp }
const PFP_CACHE = new Map();
const DEFAULT_PFP =
    "https://i.pinimg.com/564x/a4/02/fb/a402fb4ec62832b4a26aa29e0dfe2094.jpg";

/**
 * Lógica para limpar o cache a cada intervalo (para evitar vazamento de memória)
 */
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, value] of PFP_CACHE.entries()) {
        if (now - value.timestamp > PFP_CACHE_TTL_MS) {
            PFP_CACHE.delete(key);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.info(`[CACHE] Limpeza de cache concluída: ${cleanedCount} entradas removidas. (Total: ${PFP_CACHE.size})`);
    }
}, HEARTBEAT_INTERVAL_MS * 2); 

function getSafePFP(data) {
    const id = data.userId || data.uniqueId;
    if (!id) return DEFAULT_PFP;
    
    // 1. Tenta do Cache
    if (PFP_CACHE.has(id)) {
        PFP_CACHE.get(id).timestamp = Date.now(); // Atualiza o timestamp (TTL estendido)
        return PFP_CACHE.get(id).pfpUrl;
    }

    // 2. Tenta extrair de múltiplos campos (Robustez)
    const pfpUrl = (
        data.profilePictureUrl ||
        data.profilePicture?.url ||
        data.profilePicture?.thumb ||
        data.avatarThumb ||
        data.avatarMedium ||
        data.userDetails?.profilePictureUrl ||
        DEFAULT_PFP
    );

    // 3. Salva com timestamp (TTL)
    PFP_CACHE.set(id, { pfpUrl, timestamp: Date.now() });
    return pfpUrl;
}

// ------------------------------------------------------------
// CLASSE DE GERENCIAMENTO DE CONEXÃO TIKTOK
// ------------------------------------------------------------

class LiveClient {
    constructor(username) {
        this.username = username;
        this.connection = null;
        this.backoff = BACKOFF_MIN;
        this.reconnectTimer = null;
        
        // Rate Limit Props
        this.tapBuffer = 0;
        this.tapFlushTimer = null;
        this.lastTapData = {};
    }

    /**
     * Usa os métodos nativos do console (log, info, warn, error)
     */
    log(level, message) {
        const fullMessage = `[${this.username}] ${message}`;
        switch (level.toLowerCase()) {
            case 'success':
            case 'info':
                console.info(`🟢 [INFO] ${fullMessage}`);
                break;
            case 'warn':
                console.warn(`🟠 [WARN] ${fullMessage}`);
                break;
            case 'error':
                console.error(`🔴 [ERROR] ${fullMessage}`);
                break;
            default:
                console.log(`[LOG] ${fullMessage}`);
        }
    }

    cleanupConnection() {
        if (this.connection) {
            this.connection.removeAllListeners();
            this.connection.disconnect();
            this.connection = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    scheduleReconnect() {
        this.cleanupConnection(); 
        this.backoff = Math.min(this.backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX);
        this.log("warn", `Tentando reconectar em ${this.backoff.toFixed(0)}ms (Backoff).`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    }

    handleTaps(ev) {
        if (this.tapBuffer === 0) {
            this.lastTapData = {
                user: ev.uniqueId,
                nickname: ev.nickname,
                pfp: getSafePFP(ev),
                streamer: this.username
            };
        }

        this.tapBuffer += ev.likeCount;

        if (this.tapFlushTimer) return;

        this.tapFlushTimer = setTimeout(() => {
            broadcast({
                type: "tap",
                ...this.lastTapData,
                likes: this.tapBuffer,
            });

            this.tapBuffer = 0;
            this.tapFlushTimer = null;
            this.lastTapData = {};
        }, TAP_THROTTLE_MS);
    }

    setupListeners() {
        // --- Handlers de Taps e Eventos ---
        this.connection.on("like", this.handleTaps.bind(this)); 

        this.connection.on("follow", ev => {
            broadcast({
                type: "follow",
                streamer: this.username,
                nickname: ev.nickname,
                user: ev.uniqueId,
                pfp: getSafePFP(ev)
            });
        });

        this.connection.on("gift", ev => {
            if (!ev.repeatEnd) return;
            broadcast({
                type: "gift",
                streamer: this.username,
                nickname: ev.nickname,
                user: ev.uniqueId,
                giftName: ev.giftName,
                pfp: getSafePFP(ev)
            });
        });

        // --- Handlers de Estado e Erro ---
        this.connection.on("disconnected", () => {
            this.log("warn", "Conexão perdida. Iniciando reconexão...");
            this.scheduleReconnect();
        });

        this.connection.on("error", (err) => {
            this.log("error", `Erro na conexão: ${err?.message}`);
            this.scheduleReconnect();
        });
    }

    async connect() {
        this.cleanupConnection();
        this.log("info", `Conectando...`);

        this.connection = new WebcastPushConnection(this.username, {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            sessionId: API_KEY,
            requestOptions: { headers: STEALTH_HEADERS }, 
            websocketOptions: { handshakeTimeout: 15000 }
        });

        this.setupListeners();

        try {
            const state = await this.connection.connect();
            this.log("success", `Live aberta! Sala: ${state.roomId}`);
            this.backoff = BACKOFF_MIN; 
        } catch (err) {
            this.log("error", `Falha ao conectar: ${err?.message}`);
            this.scheduleReconnect();
        }
    }
}

// ------------------------------------------------------------
// INICIALIZAÇÃO
// ------------------------------------------------------------
const tiktokClients = new Map();

USERS.forEach(username => {
    const client = new LiveClient(username);
    tiktokClients.set(username, client);
    client.connect();
});

// ------------------------------------------------------------
// ROTAS DE TESTE E SIMULAÇÃO
// ------------------------------------------------------------
const SIM_PFP = "https://i.pinimg.com/originals/b0/02/76/b0027663e2d6776b9f3335e236531398.gif";
const SIM_USER = USERS[0] || "simulador";

app.get("/status", (req, res) => {
    res.send(`<h1>🟢 Ultra Server Online</h1><p>Porta: ${PORT}</p>`);
});

app.get("/simular/tap", (req, res) => {
    broadcast({
        type: "tap", streamer: SIM_USER, nickname: "Simulador Tap", user: "sim_tap", likes: 5, pfp: SIM_PFP
    });
    res.send("OK - Tap Simulado (5 curtidas)");
});

app.get("/simular/follow", (req, res) => {
    broadcast({
        type: "follow", streamer: SIM_USER, nickname: "Simulador Seg", user: "sim_seg", pfp: SIM_PFP
    });
    res.send("OK - Follow Simulado");
});

app.get("/simular/gift", (req, res) => {
    broadcast({
        type: "gift", streamer: SIM_USER, nickname: "Simulador Gift", user: "sim_gift", giftName: "Rose (Teste)", pfp: SIM_PFP
    });
    res.send("OK - Gift Simulado");
});

// ------------------------------------------------------------
// INICIAR SERVIDOR
// ------------------------------------------------------------
server.listen(PORT, () => {
    console.log("==================================================");
    console.log("PORTA LIDA DO AMBIENTE:", PORT); // LOG DE CONFIRMAÇÃO
    console.log("🟢 ULTRA SERVER ONLINE na porta:", PORT);
    console.log("==================================================");
});
