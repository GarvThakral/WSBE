import "dotenv/config";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, } from "@whiskeysockets/baileys";
import Pino from "pino";
import axios from "axios";
import qrcode from "qrcode-terminal";
const webhookUrl = process.env.WA_WEBHOOK_URL ?? "http://localhost:3000/api/auth/whatsapp/webhook";
const sessionDir = process.env.WA_SESSION_DIR ?? "./wa-session";
const appLogger = Pino({ level: process.env.WA_LOG_LEVEL ?? "info" });
async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: appLogger.child({ module: "baileys" }),
    });
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output
            ?.statusCode;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            appLogger.warn({ msg: "connection closed", statusCode, reconnect: shouldReconnect });
            if (shouldReconnect) {
                void start();
            }
        }
        else if (connection === "open") {
            appLogger.info("WhatsApp connection established");
        }
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async (event) => {
        for (const msg of event.messages) {
            if (!msg.message)
                continue;
            const from = msg.key.remoteJid;
            if (!from)
                continue;
            const text = msg.message.conversation ??
                msg.message.extendedTextMessage?.text ??
                msg.message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
                "";
            if (!text.trim())
                continue;
            try {
                await axios.post(webhookUrl, {
                    from,
                    body: text.trim(),
                }, { timeout: 5000 });
                appLogger.info({ from }, "forwarded WhatsApp code to webhook");
            }
            catch (error) {
                appLogger.error({ err: error, from }, "failed to forward WhatsApp message");
            }
        }
    });
}
void start().catch((err) => {
    appLogger.error({ err }, "failed to start WhatsApp listener");
    process.exit(1);
});
//# sourceMappingURL=wa-listener.js.map