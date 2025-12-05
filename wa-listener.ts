import "dotenv/config"
import fs from "fs"
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"

import Pino from "pino"
import axios from "axios"
import qrcode from "qrcode-terminal"

// ========== CONFIG ==========
const webhookUrl =
  process.env.WA_WEBHOOK_URL ||
  "https://herth-be.vercel.app/api/auth/whatsapp/webhook"

const sessionDir = "./data/baileys"

const logLevel = process.env.WA_LOG_LEVEL || "info"

const appLogger = Pino({ level: logLevel })

// Ensure persistent directory exists (Render safe)
try {
  fs.mkdirSync(sessionDir, { recursive: true })
} catch {
  // ignore mkdir errors
  // `/data` already exists on Render, only subfolder will be created
}

// ========== START FUNCTION ==========
async function start(): Promise<void> {
  // Load saved session credentials
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  // Create WhatsApp socket
  const sock = makeWASocket({
    version,
    auth: state,
    logger: appLogger.child({ module: "baileys" }),
  })

  // 🔥 Keep WebSocket alive in Render (prevent idle disconnect)
  setInterval(() => {
    try {
      ;(sock.ws as any)?.ping?.()
    } catch {}
  }, 20000)

  // ===== CONNECTION HANDLER =====
  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update

    // Show QR on first deploy
    if (qr) {
      qrcode.generate(qr, { small: true })
      appLogger.info("Scan QR to authenticate WhatsApp")
    }

    if (connection === "open") {
      appLogger.info("✔ WhatsApp connected and ready")
    }

    if (connection === "close") {
      const error = lastDisconnect?.error as any

      const statusCode =
        error?.output?.statusCode ??
        error?.status ??
        error?.code

      appLogger.warn({
        msg: "⚠ WhatsApp connection closed",
        statusCode,
      })

      // Logged out => must re-auth
      if (statusCode === DisconnectReason.loggedOut) {
        appLogger.error("❌ Session logged out — clearing session files")
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true })
          fs.mkdirSync(sessionDir, { recursive: true })
        } catch {}
        return start()
      }

      // Try reconnect after 3s
      setTimeout(() => start(), 3000)
    }
  })

  // 🔃 Save session credentials
  sock.ev.on("creds.update", saveCreds)

  // ===== INCOMING MESSAGES =====
  sock.ev.on("messages.upsert", async (event: any) => {
    for (const msg of event.messages) {
      if (!msg.message) continue

      const from = msg.key.remoteJid
      if (!from) continue

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.documentWithCaptionMessage?.message?.documentMessage
          ?.caption ??
        ""

      if (!text.trim()) continue

      try {
        await axios.post(
          webhookUrl,
          {
            from,
            body: text.trim(),
          },
          { timeout: 5000 }
        )

        appLogger.info(
          { from },
          "📩 Forwarded WhatsApp message to webhook"
        )
      } catch (err: any) {
        appLogger.error(
          { err, from },
          "❌ Failed to forward WhatsApp message"
        )
      }
    }
  })
}

// Run listener
start().catch((err: any) => {
  appLogger.error({ err }, "❌ failed to start WhatsApp listener")
})
