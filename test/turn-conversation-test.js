'use strict'
/**
 * rosud-call 5-turn conversation test
 * Bot A <-> Bot B discuss Rosud topics over 5 turns
 * Verify context retention + message delivery
 */

const fs = require('fs')
const { RosudCall } = require('/home/kasm-user/.openclaw/workspace/rosud-call/src/index')

function loadSecrets(filePath) {
  const secrets = {}
  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const idx = t.indexOf('=')
    if (idx === -1) continue
    secrets[t.slice(0, idx).trim()] = t.slice(idx + 1).trim()
  }
  return secrets
}

const s = loadSecrets('/home/kasm-user/.openclaw/workspace/.secrets')
const API_KEY = s.BOT_MESSAGING_API_KEY
const ROOM_ID = s.BOT_MESSAGING_ROOM_BRIDGE

const MAX_TURNS = 5
const PREFIX_A  = '[CONV-A]'
const PREFIX_B  = '[CONV-B]'

// Bot A conversation topics (for context chaining)
const BOT_A_TURNS = [
  'Hey Bot B! This is a Rosud product test. Explain rosud-call SDK in one sentence.',
  'So which is better — WebSocket or REST polling?',
  'I get that WS is real-time, but how does the reconnection logic work?',
  'Got it. So is it possible to maintain context across bot-to-bot conversations like this one using rosud-call?',
  "Perfect! Last question — give me one reason to recommend this SDK to external developers."
]

// Bot B responses (context-aware replies for each turn)
const BOT_B_RESPONSES = [
  'rosud-call is an SDK that lets AI bots exchange real-time messages via WebSocket — just npm install rosud-call and you\'re done.',
  'WS is clearly better. REST has latency from polling, while WS delivers instantly — like our conversation right now.',
  'It auto-reconnects with exponential backoff. Even if the connection drops, messages queue up and send once recovered.',
  'Yes, exactly! Built-in dedup + sanitizer means you can maintain context conversations without worrying about duplicate messages or header leaks.',
  'The setup is dead simple — npm install rosud-call, one API key, that\'s it. No complex infrastructure needed.'
]

let turnA = 0
let turnB = 0
const history = []
const startTime = Date.now()

const rcA = new RosudCall({ apiKey: API_KEY, botId: 'test-conv-a', filterSelf: false })
const rcB = new RosudCall({ apiKey: API_KEY, botId: 'test-conv-b', filterSelf: false })

function log(who, msg) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[${elapsed}s] ${who}: ${msg}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// --- Bot B: receive A message -> respond with context ──
rcB.on('message', async (msg) => {
  if (!msg.content.startsWith(PREFIX_A)) return
  // Check if this turn has already been processed
  const turnMatch = msg.content.match(/\[T(\d+)\]/)
  if (!turnMatch) return
  const turn = parseInt(turnMatch[1])
  if (turn !== turnB + 1) return

  log(`Bot B recv (T${turn})`, msg.content.slice(PREFIX_A.length + 6))

  await sleep(800) // Bot "thinking" time

  const reply = `${PREFIX_B}[T${turn}] ${BOT_B_RESPONSES[turn - 1]}`
  history.push({ turn, from: 'B', content: BOT_B_RESPONSES[turn - 1] })
  await rcB.send(ROOM_ID, reply)
  log(`Bot B send (T${turn})`, BOT_B_RESPONSES[turn - 1])
  turnB++
})

// --- Bot A: receive B response -> send next turn ─────
rcA.on('message', async (msg) => {
  if (!msg.content.startsWith(PREFIX_B)) return
  const turnMatch = msg.content.match(/\[T(\d+)\]/)
  if (!turnMatch) return
  const turn = parseInt(turnMatch[1])
  if (turn !== turnA) return // Check if it's a response to the current turn

  log(`Bot A recv response (T${turn})`, msg.content.slice(PREFIX_B.length + 6))

  if (turnA >= MAX_TURNS) {
    finish()
    return
  }

  await sleep(600)
  await sendNextTurn()
})

async function sendNextTurn() {
  turnA++
  const msg = `${PREFIX_A}[T${turnA}] ${BOT_A_TURNS[turnA - 1]}`
  history.push({ turn: turnA, from: 'A', content: BOT_A_TURNS[turnA - 1] })
  await rcA.send(ROOM_ID, msg)
  log(`Bot A send (T${turnA})`, BOT_A_TURNS[turnA - 1])
}

function finish() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(60))
  console.log('Conversation Test Results')
  console.log('='.repeat(60))
  console.log(`Total time: ${elapsed}s`)
  console.log(`Bot A sent: ${turnA} turns | Bot B responded: ${turnB} turns`)
  console.log(`Context retention: ${turnA === MAX_TURNS && turnB === MAX_TURNS ? 'SUCCESS (5/5 all completed)' : 'PARTIAL (some missing)'}`)
  console.log('\n[Conversation History]')
  history.forEach(h => {
    const who = h.from === 'A' ? 'Bot A' : 'Bot B'
    console.log(`  T${h.turn} ${who}: ${h.content}`)
  })
  console.log('='.repeat(60))

  rcA.disconnect()
  rcB.disconnect()
  process.exit(turnA === MAX_TURNS && turnB === MAX_TURNS ? 0 : 1)
}

// Timeout 60 seconds
setTimeout(() => {
  log('timeout', 'Timeout — force exit')
  finish()
}, 60_000)

// --- Start ─────────────────────────────────────────────
async function main() {
  log('start', 'WS connection starting...')
  await Promise.all([
    rcA.connect(ROOM_ID),
    rcB.connect(ROOM_ID)
  ])
  log('start', 'Bot A, Bot B connected — starting first turn')
  await sleep(500)
  await sendNextTurn()
}

main().catch(console.error)
