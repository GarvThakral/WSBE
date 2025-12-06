import "dotenv/config"
import fs from "fs"
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
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

// 🗺️ LID to Phone mapping cache
const lidToPhoneMap = new Map<string, string>()
const mapFile = `${sessionDir}/lid-phone-map.json`

// Ensure persistent directory exists
try {
  fs.mkdirSync(sessionDir, { recursive: true })
  // Load existing LID mapping
  if (fs.existsSync(mapFile)) {
    const data = JSON.parse(fs.readFileSync(mapFile, 'utf-8'))
    Object.entries(data).forEach(([lid, phone]) => {
      lidToPhoneMap.set(lid, phone as string)
    })
    appLogger.info({ mappings: lidToPhoneMap.size }, '📂 Loaded LID-to-phone mappings')
  }
} catch (err) {
  appLogger.warn({ err }, '⚠️ Could not load LID mappings')
}

// Save LID mapping to disk
function saveLidMapping() {
  try {
    const obj = Object.fromEntries(lidToPhoneMap)
    fs.writeFileSync(mapFile, JSON.stringify(obj, null, 2))
  } catch (err) {
    appLogger.error({ err }, '❌ Failed to save LID mapping')
  }
}

// ========== HELPER: RESOLVE ANY JID TO PHONE NUMBER ==========
async function resolveToPhone(
  jid: string,
  sock: WASocket,
  msg: any
): Promise<string | null> {
  // 1️⃣ Check if it's a group - skip these
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
    appLogger.debug({ jid }, '⏭️ Skipping group/broadcast message')
    return null
  }

  // 2️⃣ Already a phone number - return it and update mapping if from @lid
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0]
    if (!phone) return null
    
    // Check if this message was in reply to an @lid message
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.participant
    if (quotedMsg && quotedMsg.endsWith('@lid')) {
      const quotedLid = quotedMsg.split('@')[0]
      if (quotedLid && phone && !lidToPhoneMap.has(quotedLid)) {
        lidToPhoneMap.set(quotedLid, phone)
        saveLidMapping()
        appLogger.info({ lid: quotedLid, phone }, '🔗 Linked @lid to phone via reply context')
      }
    }
    
    return phone
  }

  // 3️⃣ Handle @lid (Linked Device)
  if (jid.endsWith('@lid')) {
    const lid = jid.split('@')[0]
    if (!lid) return null
    
    // Check cache first
    if (lidToPhoneMap.has(lid)) {
      const phone = lidToPhoneMap.get(lid)
      if (!phone) return null
      appLogger.debug({ lid, phone }, '🗺️ Using cached LID mapping')
      return phone
    }

    // 🔥 Method A: Check remoteJidAlt - THIS IS THE MAGIC FIELD!
    const remoteJidAlt = (msg.key as any).remoteJidAlt
    if (remoteJidAlt && remoteJidAlt.endsWith('@s.whatsapp.net')) {
      const phone = remoteJidAlt.split('@')[0]
      if (phone) {
        lidToPhoneMap.set(lid, phone)
        saveLidMapping()
        appLogger.info({ lid, phone, method: 'remoteJidAlt' }, '✅ Resolved @lid via remoteJidAlt & cached')
        return phone
      }
    }

    // Method B: Check message participant (works in groups and some DM scenarios)
    const participant = msg.key.participant || msg.participant
    if (participant && participant.endsWith('@s.whatsapp.net')) {
      const phone = participant.split('@')[0]
      if (phone) {
        lidToPhoneMap.set(lid, phone)
        saveLidMapping()
        appLogger.info({ lid, phone, method: 'participant' }, '✅ Resolved @lid via participant & cached')
        return phone
      }
    }

    // Method C: Check quoted/reply context
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    if (contextInfo?.participant && contextInfo.participant.endsWith('@s.whatsapp.net')) {
      const phone = contextInfo.participant.split('@')[0]
      if (phone) {
        lidToPhoneMap.set(lid, phone)
        saveLidMapping()
        appLogger.info({ lid, phone, method: 'context' }, '✅ Resolved @lid via context & cached')
        return phone
      }
    }

    // ⚠️ UNRESOLVED LID - This should rarely happen now
    appLogger.error(
      { 
        lid, 
        jid,
        remoteJidAlt: (msg.key as any).remoteJidAlt,
        pushName: msg.pushName || 'unknown',
        text: msg.message?.conversation?.substring(0, 50) || 'no text'
      },
      '❌ CRITICAL: Could not resolve @lid even with remoteJidAlt - Using LID as fallback'
    )
    
    // Return the LID number itself - at least login codes will work
    return lid
  }

  // 4️⃣ Unknown format - log and skip
  appLogger.warn({ jid }, '❓ Unknown JID format, skipping')
  return null
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
    printQRInTerminal: false,
  })

  // 🔥 Keep WebSocket alive
  setInterval(() => {
    try {
      ;(sock.ws as any)?.ping?.()
    } catch {}
  }, 20000)

  // ===== CONNECTION HANDLER =====
  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
      appLogger.info("📱 Scan QR to authenticate WhatsApp")
    }

    if (connection === "open") {
      appLogger.info("✔ WhatsApp connected and ready")
    }

    if (connection === "close") {
      const error = lastDisconnect?.error as any
      const statusCode =
        error?.output?.statusCode ?? error?.status ?? error?.code

      appLogger.warn({
        msg: "⚠ WhatsApp connection closed",
        statusCode,
      })

      if (statusCode === DisconnectReason.loggedOut) {
        appLogger.error("❌ Session logged out — clearing session files")
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true })
          fs.mkdirSync(sessionDir, { recursive: true })
        } catch {}
        return start()
      }

      setTimeout(() => start(), 3000)
    }
  })

  // 🔃 Save session credentials
  sock.ev.on("creds.update", saveCreds)

  // ===== INCOMING MESSAGES =====
  sock.ev.on("messages.upsert", async (event: any) => {
    for (const msg of event.messages) {
      if (!msg.message) continue

      const rawJid = msg.key.remoteJid
      if (!rawJid) continue

      // 🧠 Resolve to phone number
      const phone = await resolveToPhone(rawJid, sock, msg)
      if (!phone) continue

      // Extract message text
      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.documentWithCaptionMessage?.message?.documentMessage
          ?.caption ??
        ""

      if (!text.trim()) continue

      // 🔐 Only forward messages with 6-digit codes (login verification)
      const codeMatch = text.match(/\b(\d{6})\b/)
      if (!codeMatch) {
        appLogger.debug(
          { phone, text: text.substring(0, 50) },
          '⏭️ Skipping message without login code'
        )
        continue
      }

      // 📤 Forward to webhook (send ONLY numeric phone, no @domain)
      const cleanPhone = phone.replace(/@.*$/, '')
      
      try {
        await axios.post(
          webhookUrl,
          {
            from: cleanPhone,
            body: text.trim(),
          },
          { timeout: 5000 }
        )

        appLogger.info(
          { cleanPhone, originalJid: rawJid },
          "📩 Forwarded WhatsApp message to webhook"
        )
      } catch (err: any) {
        appLogger.error(
          { err, cleanPhone, originalJid: rawJid, payload: { from: cleanPhone, body: text.trim() } },
          "❌ Failed to forward WhatsApp message"
        )
      }
    }
  })
}

// Run listener
start().catch((err: any) => {
  appLogger.error({ err }, "❌ Failed to start WhatsApp listener")
})
