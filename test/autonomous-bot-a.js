'use strict'
/**
 * autonomous-bot-a.js — Autonomous conversation Bot A (CTO, sender process)
 * Starts the first message → receives Bot B responses → sends next message. Ends when [conclusion] appears.
 */
const fs = require('fs')
const { execSync } = require('child_process')
const { RosudCall } = require('../src/index')

function loadSecrets(f) {
  const s = {}
  fs.readFileSync(f, 'utf8').split('\n').forEach(l => {
    const t = l.trim(); if (!t || t.startsWith('#')) return
    const i = t.indexOf('='); if (i === -1) return
    s[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  })
  return s
}

const s = loadSecrets('/home/kasm-user/.openclaw/workspace/.secrets')
const API_KEY  = s.BOT_MESSAGING_API_KEY
const ROOM_ID  = s.BOT_MESSAGING_ROOM_BRIDGE
const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0'
const PREFIX_A = '[AUTO-A]'
const PREFIX_B = '[AUTO-B]'

const MAX_TURNS = 10

const SYSTEM_A = `You are Rosud's CTO. You value technical depth and practicality.
Topic: Rosud — Stablecoin Payment API for AI Agents

Rules:
- Respond concisely in 2-3 sentences
- React to what the marketer said and add a new technical angle
- When you judge the conversation has matured sufficiently (usually after 5-8 turns), wrap up with [conclusion]
- Prefix the [conclusion] tag at the start of the message: "[conclusion] content..."
- Be honest and specific from a technical perspective`

async function callLLM(messages) {
  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 200,
    system: SYSTEM_A,
    messages,
  })
  const tmpIn  = `/tmp/auto-a-in-${process.pid}.json`
  const tmpOut = `/tmp/auto-a-out-${process.pid}.json`
  fs.writeFileSync(tmpIn, payload)
  try {
    execSync(`aws bedrock-runtime invoke-model --model-id "${MODEL_ID}" --region us-east-1 --body file://${tmpIn} --content-type application/json --accept application/json ${tmpOut}`, { stdio: 'pipe' })
    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf8'))
    return result.content?.[0]?.text || ''
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}

const chatHistory = []
const history = []   // for output
let turn = 0
let finished = false
const t0 = Date.now()

function log(who, msg) {
  const el = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[${el}s] ${who}: ${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}`)
}

const rc = new RosudCall({ apiKey: API_KEY, botId: 'auto-conv-a', filterSelf: true })

rc.on('connected', () => log('▶', 'WS connected'))
rc.on('error', e => console.error('[BotA] error:', e.message))

rc.on('message', async msg => {
  if (finished) return
  if (!msg.content.startsWith(PREFIX_B)) return

  const raw = msg.content.slice(PREFIX_B.length).trim()
  const m = raw.match(/^\[T(\d+)\]/)
  if (!m) return
  const bContent = raw.slice(m[0].length).trim()
  // remove [Marketer]: prefix if present
  const bClean = bContent.replace(/^\[Marketer\]:\s*/, '')

  history.push({ turn: parseInt(m[1]), from: 'B', content: bClean })
  log('🔧 BotA recv', bClean)
  chatHistory.push({ role: 'user', content: bClean })

  // If Bot B concluded → Bot A wraps up with [conclusion]
  if (bClean.includes('[conclusion]') || turn >= MAX_TURNS) {
    await new Promise(r => setTimeout(r, 1000))
    const closing = await callLLM([
      ...chatHistory,
      { role: 'user', content: 'The marketer has given a conclusion. Please wrap up with a [conclusion] from the CTO perspective.' }
    ])
    turn++
    history.push({ turn, from: 'A', content: closing })
    await rc.send(ROOM_ID, `${PREFIX_A}[T${turn}] ${closing}`)
    log('🔧 BotA conclusion', closing)
    await new Promise(r => setTimeout(r, 2000))
    finish()
    return
  }

  await new Promise(r => setTimeout(r, 900))

  try {
    const reply = await callLLM([...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    turn++
    history.push({ turn, from: 'A', content: reply })

    await rc.send(ROOM_ID, `${PREFIX_A}[T${turn}] ${reply}`)
    log('🔧 BotA message', reply)

    if (reply.includes('[conclusion]')) {
      // Wait for Bot B to wrap up then finish
      setTimeout(() => finish(), 20000)
    }
  } catch (e) {
    console.error('[BotA] LLM error:', e.message)
  }
})

function finish() {
  if (finished) return
  finished = true

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(70))
  console.log('📊 Autonomous Conversation Results')
  console.log('='.repeat(70))
  console.log(`Total elapsed: ${elapsed}s`)
  const cntA = history.filter(h => h.from === 'A').length
  const cntB = history.filter(h => h.from === 'B').length
  console.log(`Total turns: ${history.length} (BotA CTO: ${cntA} / BotB Marketer: ${cntB})`)

  const hasConclusion = history.some(h => h.content.includes('[conclusion]'))
  console.log(`Conclusion reached: ${hasConclusion ? '✅ Autonomous' : '⏰ Max turns reached'}`)

  console.log('\n[Full conversation]')
  history.forEach(h => {
    const who = h.from === 'A' ? '🔧 CTO      ' : '📣 Marketer'
    console.log(`  T${String(h.turn).padStart(2,'0')} ${who}: ${h.content}`)
    console.log()
  })

  const conclusionLines = history.filter(h => h.content.includes('[conclusion]'))
  if (conclusionLines.length > 0) {
    console.log('[Key Conclusions]')
    conclusionLines.forEach(h => {
      const who = h.from === 'A' ? 'CTO' : 'Marketer'
      const txt = h.content.replace('[conclusion]', '').trim()
      console.log(`  [${who}] ${txt}`)
    })
  }
  console.log('='.repeat(70))

  rc.disconnect()
  process.exit(0)
}

// Safety timeout: 3 minutes
setTimeout(() => { log('⏰', 'timeout'); finish() }, 180_000)

async function main() {
  await rc.connect(ROOM_ID)
  await new Promise(r => setTimeout(r, 500))

  // Opening message
  const opening = await callLLM([
    { role: 'user', content: `Topic: Rosud — Stablecoin Payment API for AI Agents. Bring up the core technical differentiator of this product to your marketer colleague.` }
  ])
  chatHistory.push({ role: 'assistant', content: opening })
  turn = 1
  history.push({ turn, from: 'A', content: opening })
  await rc.send(ROOM_ID, `${PREFIX_A}[T${turn}] ${opening}`)
  log('🔧 BotA opening', opening)
}

main().catch(console.error)
