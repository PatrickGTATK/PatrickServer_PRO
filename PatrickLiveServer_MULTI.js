import "dotenv/config";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import WebcastPushConnection, { SignConfig } from "./tiktok-live-connector/index.js";

// ==============================
// CONFIG
// ==============================
const PORT = process.env.PORT || 8080;
const TIKTOK_USERS = process.env.USERS?.split(",") || [];
const API_KEY = process.env.API_KEY || "";
const app = express();
const server = http.createServer(app);

// ==============================
// WEBSOCKET SERVERS
// ==============================
const wssGift = new WebSocketServer({ noServer: true });
const wssTap = new WebSocketServer({ noServer: true });

// Envia mensagem a todos conectados
function broadcast(wss, data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// ==============================
// EXPRESS ROUTES
// ==============================
app.get("/", (req, res) => {
    res.send("Patrick Multi Server ONLINE ✔");
});

// ==============================
// CONEXÃO COM TIKTOK
// ==============================
async function iniciarConexoes() {
    console.log("🔵 Iniciando conexões TikTok...");

    for (const user of TIKTOK_USERS) {
        try {
            console.log(`🎥 Conectando em @${user} ...`);

            const tiktok = new WebcastPushConnection(user.trim());

            // Aplica chave Euler se existir
            if (API_KEY) {
                SignConfig.apiKey = API_KEY;
            }

            await tiktok.connect();

            console.log(`🟢 Connected @${user}`);

            // Gifts
            tiktok.on("gift", (data) => {
                broadcast(wssGift, {
                    type: "gift",
                    user,
                    data,
                });
            });

            // Likes / Taps
            tiktok.on("like", (data) => {
                broadcast(wssTap, {
                    type: "tap",
                    user,
                    data,
                });
            });

            // Debug
            tiktok.on("streamEnd", () => {
                console.log(`🔴 Live @${user} terminou`);
            });

        } catch (err) {
            console.log("❌ Erro ao conectar:", err);
        }
    }
}

// ==============================
// UPGRADE PARA WEBSOCKET
// ==============================
server.on("upgrade", (req, socket, head) => {
    const { url } = req;

    if (url === "/gift") {
        wssGift.handleUpgrade(req, socket, head, (ws) => {
            wssGift.emit("connection", ws, req);
            console.log("🟣 Overlay GIFT conectado");
        });
    } else if (url === "/tap") {
        wssTap.handleUpgrade(req, socket, head, (ws) => {
            wssTap.emit("connection", ws, req);
            console.log("💛 Overlay TAP conectado");
        });
    } else {
        socket.destroy();
    }
});

// ==============================
// KEEP ALIVE PARA O RENDER NÃO FECHAR
// ==============================
setInterval(() => {
    console.log("⏳ Mantendo servidor vivo...");
}, 1000 * 20);

// ==============================
// INICIAR SERVIDOR
// ==============================
server.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ONLINE na porta ${PORT}`);
    iniciarConexoes();
});
