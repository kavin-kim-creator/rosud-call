'use strict'
/**
 * rosud-call autonomous conversation test
 *
 * Bot A (CTO perspective) <-> Bot B (marketer perspective) discuss Rosud topics
 * with the LLM generating real responses in an autonomous conversation.
 * When deemed sufficiently discussed, wraps up with [conclusion].
 *
 * Run: node test/autonomous-conversation-test.js
 */

const fs = require('fs')
const { execSync } = require('child_process')
const { RosudCall } = require('../src/index')

// --- Load secrets ─────────────────────────────────────
function loadSecrets(f) {
  const s = {}
  fs.readFileSync(f, 'utf8').split('\n').forEach(l => {
    const t = l.trim()
    if (!t || t.startsWith('#')) return
    const i = t.indexOf('=')
    if (i === -1) return
    s[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  })
  return s
}

const s = loadSecrets('/home/kasm-user/.openclaw/workspace/.secrets')
const API_KEY   = s.BOT_MESSAGING_API_KEY
const ROOM_ID   = s.BOT_MESSAGING_ROOM_BRIDGE
const MODEL_ID  = 'anthropic.claude-3-haiku-20240307-v1:0'

const MAX_TURNS = 12   // maximum safety limit
const PREFIX_A  = '[AUTO-A]'
const PREFIX_B  = '[AUTO-B]'
const TOPIC     = 'Rosud — Stablecoin Payment API for AI Agents'

// --- Call Bedrock via AWS CLI ──────────────────────────
async function callLLM(systemPrompt, messages) {
  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 250,
    system: systemPrompt,
    messages,
  })
  const tmpIn  = `/tmp/bedrock-in-${process.pid}.json`
  const tmpOut = `/tmp/bedrock-out-${process.pid}.json`
  fs.writeFileSync(tmpIn, payload)
  try {
    execSync(
      `aws bedrock-runtime invoke-model \
        --model-id "${MODEL_ID}" \
        --region us-east-1 \
        --body file://${tmpIn} \
        --content-type application/json \
        --accept application/json \
        ${tmpOut}`,
      { stdio: 'pipe' }
    )
    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf8'))
    return result.content?.[0]?.text || ''
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}

// --- Bot personas ─────────────────────────────────────
const SYSTEM_A = `You are Rosud's CTO. You value technical depth and practicality.
Topic: ${TOPIC}
Rules:
- Respond concisely in 2-3 sentences
- React to what the other person said and add a new angle
- When you judge the conversation has matured sufficiently (usually after 5-8 turns), wrap up with a 1-2 line summary of key insights using the [conclusion] tag
- Once you use the [conclusion] tag, that is your final statement
- Speak honestly from a technical perspective`

const SYSTEM_B = `You are Rosud's marketer. You value market viability and user perspective.
Topic: ${TOPIC}
Rules:
- Respond concisely in 2-3 sentences
- React to what the other person said and add a marketing/business angle
- If the other party has given a [conclusion], wrap up with your own marketing-perspective [conclusion]
- Even without a [conclusion] tag, if you judge the conversation is sufficiently complete (5+ turns), you can give a [conclusion] first
- Think about how to position a developer-targeted product in the market`

// --- Conversation engine ───────────────────────────────
const history = []   // { turn, from, content }
const chatHistory = []  // LLM message history

let turn = 0
let concluded = false
let concludedBy = null
const t0 = Date.now()

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function log(who, msg) {
  const el = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[${el}s] ${who}: ${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}`)
}

const rcA = new RosudCall({ apiKey: API_KEY, botId: 'auto-conv-a', filterSelf: false })
const rcB = new RosudCall({ apiKey: API_KEY, botId: 'auto-conv-b', filterSelf: false })

// Bot B: generate LLM response when A message received
rcB.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_A)) return
  if (concluded) return

  const content = msg.content.slice(PREFIX_A.length).trim()
  const turnMatch = content.match(/^\[T(\d+)\]/)
  if (!turnMatch) return
  const t = parseInt(turnMatch[1])
  const actualContent = content.slice(turnMatch[0].length).trim()

  log('Bot B recv', actualContent)

  // Add Bot A statement to LLM history
  chatHistory.push({ role: 'user', content: `[CTO]: ${actualContent}` })

  await sleep(1000)

  try {
    const reply = await callLLM(SYSTEM_B, [...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    history.push({ turn: t, from: 'B', content: reply })

    const outMsg = `${PREFIX_B}[T${t}] ${reply}`
    await rcB.send(ROOM_ID, outMsg)
    log('Bot B reply', reply)

    if (reply.includes('[conclusion]')) {
      concludedBy = concludedBy || 'B'
      if (concludedBy === 'A') finish()  // A concluded first -> B also concludes -> done
      else concluded = true
    }
  } catch (e) {
    console.error('[BotB] LLM error:', e.message)
  }
})

// Bot A: generate next LLM reply when Bot B responds
rcA.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_B)) return
  if (concluded && concludedBy === 'B') { finish(); return }

  const content = msg.content.slice(PREFIX_B.length).trim()
  const turnMatch = content.match(/^\[T(\d+)\]/)
  if (!turnMatch) return
  const actualContent = content.slice(turnMatch[0].length).trim()

  log('Bot A recv', actualContent)

  if (turn >= MAX_TURNS) { finish(); return }

  // Add Bot B statement to LLM history
  chatHistory.push({ role: 'user', content: `[Marketer]: ${actualContent}` })

  await sleep(1000)

  try {
    const reply = await callLLM(SYSTEM_A, [...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    turn++
    history.push({ turn, from: 'A', content: reply })

    const outMsg = `${PREFIX_A}[T${turn}] ${reply}`
    await rcA.send(ROOM_ID, outMsg)
    log('Bot A statement', reply)

    if (reply.includes('[conclusion]')) {
      concludedBy = 'A'
      // Wait for B's closing [conclusion] response (auto-finish after 10s)
      setTimeout(() => { if (!concluded) finish() }, 15000)
    }
  } catch (e) {
    console.error('[BotA] LLM error:', e.message)
  }
})

function finish() {
  if (concluded) return
  concluded = true

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(70))
  console.log('Autonomous Conversation Results')
  console.log('='.repeat(70))
  console.log(`Total time: ${elapsed}s`)
  console.log(`Total statements: ${history.length} turns (Bot A: ${history.filter(h=>h.from==='A').length} / Bot B: ${history.filter(h=>h.from==='B').length})`)

  const conclusionA = history.filter(h => h.from === 'A' && h.content.includes('[conclusion]'))
  const conclusionB = history.filter(h => h.from === 'B' && h.content.includes('[conclusion]'))
  console.log(`Conclusion reached: ${conclusionA.length > 0 || conclusionB.length > 0 ? 'Autonomously reached' : 'Max turns reached'}`)

  console.log('\n[Full Conversation]')
  history.forEach(h => {
    const who = h.from === 'A' ? 'CTO     ' : 'Marketer'
    const lines = h.content.split('\n')
    lines.forEach((line, i) => {
      if (i === 0) console.log(`  T${String(h.turn).padStart(2,'0')} ${who}: ${line}`)
      else         console.log(`         ${line}`)
    })
  })

  if (conclusionA.length > 0) {
    console.log('\n[CTO Conclusion]')
    console.log(conclusionA[0].content.replace('[conclusion]', '').trim())
  }
  if (conclusionB.length > 0) {
    console.log('\n[Marketer Conclusion]')
    console.log(conclusionB[0].content.replace('[conclusion]', '').trim())
  }
  console.log('='.repeat(70))

  rcA.disconnect()
  rcB.disconnect()
  process.exit(0)
}

// Safety guard: force exit after 3 minutes
setTimeout(() => { log('timeout', '3-minute timeout'); finish() }, 180_000)

// --- Start: Bot A makes the first statement ────────────
async function main() {
  log('start', 'WS connection starting...')
  await Promise.all([rcA.connect(ROOM_ID), rcB.connect(ROOM_ID)])
  log('start', 'Connected — autonomous conversation starting')
  await sleep(500)

  // Bot A opening statement (LLM generated)
  const opening = await callLLM(SYSTEM_A, [
    { role: 'user', content: `Topic: ${TOPIC}. Start by presenting the key technical differentiator of this product to your marketer colleague.` }
  ])
  chatHistory.push({ role: 'assistant', content: opening })
  turn = 1
  history.push({ turn, from: 'A', content: opening })

  const outMsg = `${PREFIX_A}[T${turn}] ${opening}`
  await rcA.send(ROOM_ID, outMsg)
  log('Bot A opening', opening)
}

main().catch(console.error)
