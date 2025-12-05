import "dotenv/config"
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys"

import Pino from "pino"
import axios from "axios"
import qrcode from "qrcode-terminal"

const webhookUrl = process.env.WA_WEBHOOK_URL ?? "https://herth-be.vercel.app/api/auth/whatsapp/webhook"
const sessionDir = process.env.WA_SESSION_DIR || "/data/wa-session"
const appLogger = Pino({ level: process.env.WA_LOG_LEVEL ?? "info" })

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: appLogger.child({ module: "baileys" }),
  })

  // KEEP SOCKET ALIVE ON RENDER 🔥
  setInterval(() => {
    try {
      ;(sock.ws as any)?.ping?.()

    } catch {}
  }, 20000)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      appLogger.info("WhatsApp connection established")
    }

    if (connection === "close") {
      const error = lastDisconnect?.error
      const statusCode = error?.output?.statusCode

      appLogger.warn({ msg: "connection closed", statusCode })

      // SESSION REPLACED / LOGGED OUT ❗
      if (statusCode === DisconnectReason.loggedOut) {
        appLogger.error("Session logged out. Resetting...")
        await sock.logout()
        return start()
      }

      // RECONNECT
      setTimeout(() => start(), 3000)
    }
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("messages.upsert", async (event) => {
    for (const msg of event.messages) {
      if (!msg.message) continue
      const from = msg.key.remoteJid
      if (!from) continue

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
        ""

      if (!text.trim()) continue

      try {
        await axios.post(
          webhookUrl,
          {
            from,
            body: text.trim(),
          },
          { timeout: 5000 },
        )
        appLogger.info({ from }, "forwarded WhatsApp code to webhook")
      } catch (error) {
        appLogger.error({ err: error, from }, "failed to forward WhatsApp message")
      }
    }
  })
}

start()
