'use strict'
/**
 * test/bot-a.js — Test Bot A (send + verify)
 *
 * Sends 10 messages to BOT_MESSAGING_ROOM_BRIDGE room (1 second interval).
 * Receives Bot B echo responses and verifies they don't include self-echoes.
 *
 * Run: node test/bot-a.js  (requires bot-b.js to be running first)
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
    console.error('[BotA] failed to load .secrets file:', e.message)
    process.exit(1)
  }
  return secrets
}

const SECRETS_PATH = '/home/kasm-user/.openclaw/workspace/.secrets'
const s = loadSecrets(SECRETS_PATH)

const API_KEY = s.BOT_MESSAGING_API_KEY
const BOT_ID  = s.BOT_MESSAGING_BOT_ID || 'test-bot-a'
const ROOM_ID = s.BOT_MESSAGING_ROOM_BRIDGE

if (!API_KEY || !ROOM_ID) {
  console.error('[BotA] missing required env vars: BOT_MESSAGING_API_KEY, BOT_MESSAGING_ROOM_BRIDGE')
  process.exit(1)
}

const TOTAL    = 10
const INTERVAL = 1000   // 1 second

// Same API key environment: server determines sender_id based on API key,
// so Bot B echoes also arrive with sender_id === botId → filterSelf: false required
const rc = new RosudCall({ apiKey: API_KEY, botId: BOT_ID, filterSelf: false })

let sent     = 0
let received = 0

rc.on('connected', () => console.log('[BotA] WS connected — starting send'))
rc.on('error',     (e) => console.error('[BotA] error:', e.message))

rc.on('message', (msg) => {
  // Same API key environment: all sender_ids are the same, distinguish by content prefix only
  // [A] prefix = own message, [B][echo] prefix = Bot B echo
  if (msg.content.startsWith('[A]')) {
    // Own sent message - ignore
    return
  }
  if (msg.content.startsWith('[B][echo]')) {
    received++
    console.log(`[BotA] echo received (${received}/${TOTAL}): ${msg.content.slice(0, 60)}`)
    if (received >= TOTAL) finish()
  }
})

async function sendLoop() {
  for (let i = 1; i <= TOTAL; i++) {
    const ts  = new Date().toISOString().slice(11, 19)
    const msg = `[A] Test ${i}/${TOTAL}: rosud-call SDK test — ${ts}`
    await rc.send(ROOM_ID, msg)
    sent++
    console.log(`[BotA] sent (${i}/${TOTAL}): ${msg}`)
    if (i < TOTAL) await sleep(INTERVAL)
  }
  console.log('[BotA] send complete. Waiting for echo responses...')
  setTimeout(() => finish('timeout'), 30_000)
}

function finish(reason = 'done') {
  console.log('\n=== Results ===')
  console.log(`sent: ${sent} / received (echo): ${received}`)
  console.log(`result: ${received === TOTAL ? 'all received' : `${TOTAL - received} missing`}`)
  console.log(`exit reason: ${reason}`)
  rc.disconnect()
  process.exit(received === TOTAL ? 0 : 1)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

rc.connect(ROOM_ID)
  .then(() => sendLoop())
  .catch(console.error)
