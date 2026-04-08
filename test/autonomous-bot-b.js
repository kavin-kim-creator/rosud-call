'use strict'
/**
 * autonomous-bot-b.js — Autonomous conversation Bot B (Marketer, receiver process)
 * Receives PREFIX_A messages and generates LLM responses. Ends when [conclusion] appears.
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

const SYSTEM_B = `You are Rosud's marketer. You value market viability and user perspective.
Topic: Rosud — Stablecoin Payment API for AI Agents

Rules:
- Respond concisely in 2-3 sentences
- React to what the CTO said and add a marketing/business angle
- After 5+ turns, you can proactively give a [conclusion]
- If the other party has given a [conclusion], wrap up with your own marketing-perspective [conclusion]
- Prefix the [conclusion] tag at the start: "[conclusion] content..."
- Think about how to position a developer-targeted product in the market`

async function callLLM(messages) {
  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 200,
    system: SYSTEM_B,
    messages,
  })
  const tmpIn  = `/tmp/auto-b-in-${process.pid}.json`
  const tmpOut = `/tmp/auto-b-out-${process.pid}.json`
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
let turnCount = 0
const t0 = Date.now()

const rc = new RosudCall({ apiKey: API_KEY, botId: 'auto-conv-b', filterSelf: true })

rc.on('connected', () => process.stderr.write('[BotB] WS connected\n'))
rc.on('error', e => process.stderr.write(`[BotB] error: ${e.message}\n`))

rc.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_A)) return

  const raw = msg.content.slice(PREFIX_A.length).trim()
  const m = raw.match(/^\[T(\d+)\]/)
  if (!m) return
  const t = parseInt(m[1])
  const aContent = raw.slice(m[0].length).trim()

  const el = ((Date.now() - t0) / 1000).toFixed(1)
  // remove [CTO]: prefix if present
  const aClean = aContent.replace(/^\[CTO\]:\s*/, '')

  process.stderr.write(`[${el}s] 📣 BotB recv T${t}: ${aClean.slice(0, 60)}\n`)

  chatHistory.push({ role: 'user', content: aClean })

  await new Promise(r => setTimeout(r, 900))

  try {
    const reply = await callLLM([...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    turnCount++

    const out = `${PREFIX_B}[T${t}] ${reply}`
    await rc.send(ROOM_ID, out)
    process.stderr.write(`[${((Date.now()-t0)/1000).toFixed(1)}s] 📣 BotB reply T${t}: ${reply.slice(0, 60)}\n`)

    // If Bot B concluded → wait 15s for Bot A to wrap up, then exit
    if (reply.includes('[conclusion]')) {
      setTimeout(() => { rc.disconnect(); process.exit(0) }, 15000)
    }
  } catch (e) {
    process.stderr.write(`[BotB] LLM error: ${e.message}\n`)
  }
})

process.stderr.write('[BotB] started — waiting for BotA messages... (auto-exit after 3 minutes)\n')
rc.connect(ROOM_ID).catch(console.error)

setTimeout(() => { rc.disconnect(); process.exit(0) }, 180_000)
