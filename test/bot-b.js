'use strict'
/**
 * test/bot-b.js — Test Bot B (receive + echo)
 *
 * Subscribes to BOT_MESSAGING_ROOM_BRIDGE room.
 * Replies to received messages with "[B][echo] {content}".
 * Auto-exits after 60 seconds.
 *
 * Run: node test/bot-b.js  (start before bot-a.js)
 */

const fs = require('fs')
const { RosudCall } = require('../src/index')

// Load credentials from .secrets file
function loadSecrets(filePath) {
  const secrets = {}
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      secrets[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
  } catch (e) {
    console.error('[BotB] failed to load .secrets file:', e.message)
    process.exit(1)
  }
  return secrets
}

const SECRETS_PATH = '/home/kasm-user/.openclaw/workspace/.secrets'
const s = loadSecrets(SECRETS_PATH)

const API_KEY = s.BOT_MESSAGING_API_KEY
const ROOM_ID = s.BOT_MESSAGING_ROOM_BRIDGE
// Use a different bot_id from Bot A (same API key differentiated by bot_id)
const BOT_ID  = s.BOT_MESSAGING_BOT_B_ID || (s.BOT_MESSAGING_BOT_ID + '-b')

if (!API_KEY || !ROOM_ID) {
  console.error('[BotB] missing required env vars: BOT_MESSAGING_API_KEY, BOT_MESSAGING_ROOM_BRIDGE')
  process.exit(1)
}

const rc = new RosudCall({ apiKey: API_KEY, botId: BOT_ID })

rc.on('connected',    ()    => console.log('[BotB] WS connected'))
rc.on('disconnected', ()    => console.log('[BotB] disconnected'))
rc.on('reconnecting', (sec) => console.log(`[BotB] reconnecting in ${sec}s`))
rc.on('error',        (err) => console.error('[BotB] error:', err.message))

rc.on('message', async (msg) => {
  console.log(`[BotB] received: ${msg.senderId} → ${msg.content.slice(0, 60)}`)

  // [B] prefix = own echo or another Bot B message → ignore
  if (msg.content.startsWith('[B]')) return

  if (msg.content.startsWith('[A]')) {
    const reply = `[B][echo] ${msg.content}`
    await rc.send(ROOM_ID, reply)
    console.log(`[BotB] echo sent: ${reply.slice(0, 60)}`)
  }
})

console.log('[BotB] started — waiting for Bot A messages... (auto-exit after 60s)')
rc.connect(ROOM_ID).catch(console.error)

// Auto-exit after 60 seconds
setTimeout(() => {
  console.log('[BotB] 60s elapsed — auto-exit')
  rc.disconnect()
  process.exit(0)
}, 60_000)
