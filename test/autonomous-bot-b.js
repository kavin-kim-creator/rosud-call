'use strict'
/**
 * autonomous-bot-b.js — 자율 대화 봇B (마케터, 수신 프로세스)
 * PREFIX_A 메시지 받으면 LLM으로 응답 생성. [결론] 나오면 종료.
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

const SYSTEM_B = `너는 Rosud의 마케터야. 시장성과 사용자 관점을 중시해.
주제: Rosud — AI 에이전트용 스테이블코인 결제 API

규칙:
- 2-3문장으로 간결하게 응답해
- 상대방(CTO) 말에 반응하고 마케팅/비즈니스 관점을 추가해
- 대화가 5턴 이상 지속되면 스스로 [결론]을 낼 수 있어
- 상대가 [결론]을 냈으면 반드시 마케팅 관점 [결론]으로 마무리해
- [결론]은 메시지 맨 앞에 붙여: "[결론] 내용..."
- 개발자 타겟 제품을 시장에서 어떻게 포지셔닝할지 고민해`

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

rc.on('connected', () => process.stderr.write('[봇B] WS 연결됨\n'))
rc.on('error', e => process.stderr.write(`[봇B] 에러: ${e.message}\n`))

rc.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_A)) return

  const raw = msg.content.slice(PREFIX_A.length).trim()
  const m = raw.match(/^\[T(\d+)\]/)
  if (!m) return
  const t = parseInt(m[1])
  const aContent = raw.slice(m[0].length).trim()

  const el = ((Date.now() - t0) / 1000).toFixed(1)
  // [CTO]: prefix 제거
  const aClean = aContent.replace(/^\[CTO\]:\s*/, '')

  process.stderr.write(`[${el}s] 📣 봇B 수신 T${t}: ${aClean.slice(0, 60)}\n`)

  chatHistory.push({ role: 'user', content: aClean })

  await new Promise(r => setTimeout(r, 900))

  try {
    const reply = await callLLM([...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    turnCount++

    const out = `${PREFIX_B}[T${t}] ${reply}`
    await rc.send(ROOM_ID, out)
    process.stderr.write(`[${((Date.now()-t0)/1000).toFixed(1)}s] 📣 봇B 응답 T${t}: ${reply.slice(0, 60)}\n`)

    // 봇B가 [결론] 냈으면 15초 후 종료 (봇A 마무리 대기)
    if (reply.includes('[결론]')) {
      setTimeout(() => { rc.disconnect(); process.exit(0) }, 15000)
    }
  } catch (e) {
    process.stderr.write(`[봇B] LLM 오류: ${e.message}\n`)
  }
})

// A의 [결론] 메시지 감지 → 봇B도 마무리 [결론] 유도
rc.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_A)) return
  if (msg.content.includes('[결론]')) {
    // 이미 위 핸들러에서 처리됨
  }
})

process.stderr.write('[봇B] 시작 — 봇A 메시지 대기 중... (3분 후 자동 종료)\n')
rc.connect(ROOM_ID).catch(console.error)

setTimeout(() => { rc.disconnect(); process.exit(0) }, 180_000)
