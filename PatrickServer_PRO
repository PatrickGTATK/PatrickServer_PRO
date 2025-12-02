import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { WebcastPushConnection } from "./tiktok-live-connector/index.js";
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

// NOVIDADE: Chave para proteger a rota de monitoramento /status
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin_secret_padrao_mude_isso"; 

// Parâmetros de Resiliência/Backoff Exponencial
const BASE_RECONNECT_DELAY_SECONDS = 15;
const MAX_BACKOFF_DELAY_MINUTES = 60; 
const MAX_CONSECUTIVE_FAILURES = 10; 

// NOVIDADE: Tolerância a Falhas de Proxy
const MAX_PROXY_FAILURES = 5; // Limite de falhas de proxy antes de tentar o fallback
const PROXY_FALLBACK_DELAY_MINUTES = 15; // Tempo de espera na conexão direta antes de voltar ao proxy

// Heartbeat
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
        if (!Array.isArray(USERS)) {
            throw new Error("O JSON da variável USERS_JSON não é um array de usuários.");
        }
        logger.info(`USERS_JSON (ENV) carregado: ${USERS.length} usuários.`);
    } catch (e) {
        logger.error(`ERRO CRÍTICO ao processar USERS_JSON (ENV).`, { error: e.message });
        process.exit(1); 
    }
} else {
    logger.warn("A variável de ambiente USERS_JSON não está configurada. O servidor iniciará sem conexões TikTok.");
}

// Mapear conexões e sockets
const tiktokConnections = new Map(); 
const wsClients = new Map(); 

// Mapear dados de controle de conexão
const connectionMetrics = new Map(); // token -> { failures: 0, nextAttempt: 0, isPaused: false, lastSuccess: 0, proxyFailures: 0, usingDirect: false }

const app = express();
const server = http.createServer(app);

// ------------------------------------------------------------
// FUNÇÕES DE WEBSOCKET (HEARTBEAT)
// ------------------------------------------------------------

function noop() {}
function heartbeat() { this.isAlive = true; }

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            if (ws.isAlive === false) {
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping(noop); 
        }
    });
}, HEARTBEAT_INTERVAL);

server.on('close', () => {
    clearInterval(pingInterval);
});

// ------------------------------------------------------------
// FUNÇÃO AUXILIAR: CALCULAR DELAY EXPONENCIAL
// ------------------------------------------------------------
function calculateBackoffDelay(metrics) {
    // Se estiver em modo de fallback direto e falhar, usa delay curto e volta para o proxy
    if (metrics.usingDirect) {
        return PROXY_FALLBACK_DELAY_MINUTES * 60; // 15 minutos de delay e então volta ao proxy
    }

    // Se falhou por proxy e atingiu o limite, usa delay do backoff normal
    if (metrics.failures >= MAX_CONSECUTIVE_FAILURES) {
        return MAX_BACKOFF_DELAY_MINUTES * 60; // Delay máximo (60 minutos)
    }

    // Backoff exponencial padrão
    const delay = BASE_RECONNECT_DELAY_SECONDS * Math.pow(2, metrics.failures);
    return Math.min(delay, MAX_BACKOFF_DELAY_MINUTES * 60);
}

// ------------------------------------------------------------
// FUNÇÃO PRINCIPAL → Criar/Gerenciar conexão TikTok individual
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
        logger.warn(`Conexão @${tiktokUser} está PAUSADA (sem overlays). Não será iniciada.`, { token });
        return;
    }

    // Determina a opção de proxy baseada nas métricas de falha
    let proxyOption = PROXY_URL || undefined;
    if (metrics.usingDirect) {
        // Se a métrica diz para usar a conexão direta, define como undefined
        proxyOption = undefined;
        logger.warn(`Conexão @${tiktokUser} usando o modo de FALLBACK (Conexão Direta).`, { token });
    } else if (PROXY_URL) {
        // Loga que está usando o proxy
        logger.info(`Conexão @${tiktokUser} usando Proxy.`, { token });
    }
    
    logger.info(`Iniciando conexão TikTok para: ${tiktokUser}`, { token });

    const client = new WebcastPushConnection(tiktokUser, {
        processInitialData: true,
        enableWebsocket: true,
        proxy: proxyOption 
    });

    // --- EVENTOS DE CONTROLE DA CONEXÃO TIKTOK ---
    
    client.on("disconnected", () => {
        // Lógica para detecção e transição de falha de proxy
        let delay;
        let logMessage;
        
        if (proxyOption && !metrics.usingDirect) { // Se falhou usando o proxy
            metrics.proxyFailures++;
            if (metrics.proxyFailures >= MAX_PROXY_FAILURES) {
                // Ativamos o modo Fallback
                metrics.usingDirect = true;
                metrics.failures = 0; // Reseta falhas gerais no fallback
                delay = BASE_RECONNECT_DELAY_SECONDS; // Tenta o fallback rápido
                logMessage = `PROXY falhou ${metrics.proxyFailures}x. Iniciando FALLBACK para conexão DIRETA.`;
            }
        } else if (metrics.usingDirect) { // Se falhou usando a conexão direta (fallback)
            // Reseta o modo Fallback e volta ao proxy com delay maior
            metrics.usingDirect = false; 
            metrics.proxyFailures = 0;
            metrics.failures++; // Conta como falha geral
            delay = PROXY_FALLBACK_DELAY_MINUTES * 60; // 15 minutos antes de voltar ao proxy
            logMessage = `FALLBACK falhou. Voltando ao Proxy em ${PROXY_FALLBACK_DELAY_MINUTES} minutos.`;
        }

        // Se nenhuma transição de proxy ocorreu (apenas falha normal)
        if (!logMessage) {
            metrics.failures++;
            delay = calculateBackoffDelay(metrics);
            logMessage = metrics.failures >= MAX_CONSECUTIVE_FAILURES 
                ? `Falhou ${metrics.failures} vezes. Usando delay MÁXIMO de ${MAX_BACKOFF_DELAY_MINUTES}m.`
                : `Desconectada. Próxima tentativa em ${delay}s (Backoff Exp).`;
        }
        
        metrics.nextAttempt = Date.now() + (delay * 1000); 
        connectionMetrics.set(token, metrics);
        logger.warn(`Conexão @${tiktokUser} ${logMessage}`, { token, failures: metrics.failures, proxyFailures: metrics.proxyFailures });
        
        tiktokConnections.delete(token);
        client.removeAllListeners(); 

        setTimeout(() => {
            createTikTokConnection(token, tiktokUser);
        }, delay * 1000);

        sendToToken(token, { type: "system", data: { status: "disconnected", user: tiktokUser, reconnectingIn: delay } });
    });
    
    client.on("error", (err) => {
        logger.error(`ERRO na conexão @${tiktokUser}: ${err.message}`, { token, error: err.message });
        const errorMessage = err.message.substring(0, 150); 
        sendToToken(token, { type: "system", data: { status: "error", user: tiktokUser, message: errorMessage } });
    });

    // --- TENTAR CONECTAR ---
    try {
        await client.connect();
        logger.info(`Conectado com sucesso: @${tiktokUser}`, { token });
        
        // Reseta as métricas após sucesso
        metrics.failures = 0;
        metrics.nextAttempt = 0;
        metrics.proxyFailures = 0;
        metrics.usingDirect = false; // Garante que volta ao proxy após sucesso
        metrics.lastSuccess = Date.now();
        connectionMetrics.set(token, metrics);

        // Registra eventos de DADOS SOMENTE APÓS CONEXÃO BEM-SUCEDIDA
        client.on("chat", (msg) => { sendToToken(token, { type: "chat", data: msg }); });
        client.on("gift", (msg) => { sendToToken(token, { type: "gift", data: msg }); });
        client.on("like", (msg) => { sendToToken(token, { type: "like", data: msg }); });
        client.on("follow", (msg) => { sendToToken(token, { type: "follow", data: msg }); });
        client.on("share", (msg) => { sendToToken(token, { type: "share", data: msg }); });
        client.on("viewer", (msg) => { sendToToken(token, { type: "viewer", data: msg }); });
        
        tiktokConnections.set(token, client);
        sendToToken(token, { type: "system", data: { status: "connected", user: tiktokUser } });

    } catch (err) {
        logger.error(`Falha ao conectar @${tiktokUser} na tentativa inicial.`, { token, error: err.message });
        
        client.removeAllListeners(); 
        client.disconnect(); // Dispara o evento "disconnected" para iniciar o ciclo de reconexão
    }
}

// ------------------------------------------------------------
// FUNÇÃO → enviar evento para todos os overlays do token
// ------------------------------------------------------------
function sendToToken(token, payload) {
    const clients = wsClients.get(token);
    if (!clients) return;

    const json = JSON.stringify(payload);
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
}

// ------------------------------------------------------------
// INICIAR conexões TikTok para todos os usuários ativos
// ------------------------------------------------------------
async function startAllConnections() {
    if (USERS.length === 0) {
        logger.warn("Lista de usuários vazia. Nenhuma conexão será iniciada.");
        return;
    }

    for (const user of USERS) {
        if (user.active !== true && user.ativo !== true) continue; 

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
// MIDDLEWARE DE SEGURANÇA: Proteger Rota de Status
// ------------------------------------------------------------
function authenticateAdmin(req, res, next) {
    const adminSecretHeader = req.headers['x-admin-secret'];
    
    if (adminSecretHeader === ADMIN_SECRET) {
        next();
    } else {
        logger.warn('Acesso não autorizado à rota /status.');
        res.status(401).send('Acesso não autorizado. Chave de administrador ausente ou inválida.');
    }
}

// ------------------------------------------------------------
// ROTAS HTTP
// ------------------------------------------------------------
app.get("/", (req, res) => {
    res.send("🟢 PatrickServer_PRO — ONLINE");
});

// Rota de Status de Conexão (Monitoramento) - AGORA PROTEGIDA!
app.get("/status", authenticateAdmin, (req, res) => {
    const now = Date.now();
    const connectionsStatus = USERS.map(user => {
        const isConnected = tiktokConnections.has(user.token);
        const activeOverlays = wsClients.get(user.token)?.size || 0;
        const metrics = connectionMetrics.get(user.token) || { failures: 0, nextAttempt: 0, isPaused: false, lastSuccess: 0, proxyFailures: 0, usingDirect: false };
        
        let detailedStatus = "Conexão Ativa";
        if (metrics.isPaused) {
            detailedStatus = "PAUSADA (Sem Overlays)";
        } else if (!isConnected && metrics.failures > 0) {
            const nextAttemptDate = new Date(metrics.nextAttempt).toLocaleTimeString('pt-BR');
            
            if (metrics.usingDirect) {
                 detailedStatus = `FALLBACK DIRETO: ${metrics.proxyFailures} falhas. Próx. Tentativa: ${nextAttemptDate}`;
            } else if (metrics.nextAttempt > now) {
                detailedStatus = `FALHA (${metrics.failures}x, Proxy ${metrics.proxyFailures}x). Próx. Tentativa: ${nextAttemptDate}`;
            } else {
                 detailedStatus = `FALHA (${metrics.failures}x). Reconectando AGORA.`;
            }
        }

        return {
            tiktokUser: user.tiktokUser,
            token: user.token,
            active: user.active === true || user.ativo === true,
            status: detailedStatus,
            activeOverlays: activeOverlays,
            consecutiveFailures: metrics.failures,
            proxyFailures: metrics.proxyFailures,
            proxyMode: metrics.usingDirect ? 'DIRETO (Fallback)' : (PROXY_URL ? 'PROXY' : 'DIRETO'),
            lastSuccessfulConnection: metrics.lastSuccess ? new Date(metrics.lastSuccess).toLocaleString('pt-BR') : 'N/A'
        };
    });
    
    res.json({
        serverStatus: "ONLINE",
        proxyConfig: PROXY_URL ? "ATIVO" : "INATIVO",
        totalUsers: USERS.length,
        activeTikTokConnections: tiktokConnections.size,
        activeWsClients: wss.clients.size,
        connections: connectionsStatus
    });
});

// Overlay por token
app.use("/overlay", express.static("./overlay")); 

// ------------------------------------------------------------
// WEBSOCKET PARA OS OVERLAYS
// ------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
    // Heartbeat setup
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    
    const params = new URLSearchParams(req.url.replace("/ws?", ""));
    const token = params.get("token");
    const secret = params.get("secret");

    if (secret !== WS_SECRET) {
        ws.close();
        logger.warn(`Tentativa de conexão WS bloqueada (Secret Inválida)`);
        return;
    }
    
    if (!token) {
        ws.close();
        logger.warn(`Tentativa de conexão WS bloqueada (Token Ausente)`);
        return;
    }

    // ... [Restante da lógica de conexão WS e Pausa/Unpause] ...

    // Recupera o usuário
    const user = USERS.find(u => u.token === token);
    if (!user || (user.active !== true && user.ativo !== true)) {
        ws.close();
        logger.warn(`Conexão WS bloqueada (Token não ativo): ${token}`);
        return;
    }

    // Gerenciamento de Pausa/Unpause
    const metrics = connectionMetrics.get(token);
    if (metrics && metrics.isPaused) {
        // Se estava pausado, reativa e tenta iniciar a conexão TikTok
        metrics.isPaused = false;
        createTikTokConnection(token, user.tiktokUser);
        logger.info(`Conexão @${user.tiktokUser} REATIVADA devido a novo overlay.`, { token });
    }

    // Registrar cliente
    if (!wsClients.has(token)) wsClients.set(token, new Set());
    wsClients.get(token).add(ws);

    logger.info(`Overlay conectado → token: ${token} | Total p/ token: ${wsClients.get(token).size}`, { token });

    ws.on("close", () => {
        wsClients.get(token)?.delete(ws);
        clearTimeout(ws.pingTimeout); 
        
        const remainingClients = wsClients.get(token)?.size || 0;
        logger.info(`Overlay desconectado → token: ${token} | Restantes: ${remainingClients}`, { token });
        
        // Pausa a conexão TikTok se não houver mais overlays
        if (remainingClients === 0 && tiktokConnections.has(token)) {
            const client = tiktokConnections.get(token);
            client.removeAllListeners();
            client.disconnect();
            tiktokConnections.delete(token);

            if (metrics) metrics.isPaused = true;
            logger.warn(`Conexão @${user.tiktokUser} PAUSADA. Zero overlays ativos.`, { token });
        }
    });

    ws.on('error', (error) => {
        logger.error(`Erro no WS do token ${token}: ${error.message}`, { token, error: error.message });
    });
});

// ------------------------------------------------------------
// INICIAR SERVIDOR
// ------------------------------------------------------------
server.listen(PORT, () => {
    logger.info(`PatrickServer_PRO rodando na porta ${PORT}`);
});
