'use strict'
/**
 * autonomous-bot-a.js — 자율 대화 봇A (CTO, 발신 프로세스)
 * 첫 발언 시작 → 봇B 응답 수신 → 다음 발언. [결론] 나오면 종료.
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

const SYSTEM_A = `너는 Rosud의 CTO야. 기술적 깊이와 실용성을 중시해.
주제: Rosud — AI 에이전트용 스테이블코인 결제 API

규칙:
- 2-3문장으로 간결하게 응답해
- 상대방(마케터) 말에 반응하고 새로운 기술적 각도를 추가해
- 대화가 충분히 무르익었다고 판단되면 (보통 5-8턴 이후) [결론]으로 핵심 인사이트 정리
- [결론]은 메시지 맨 앞에 붙여: "[결론] 내용..."
- 기술적 관점에서 솔직하고 구체적으로 말해`

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
const history = []   // 출력용
let turn = 0
let finished = false
const t0 = Date.now()

function log(who, msg) {
  const el = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[${el}s] ${who}: ${msg.slice(0, 80)}${msg.length > 80 ? '...' : ''}`)
}

const rc = new RosudCall({ apiKey: API_KEY, botId: 'auto-conv-a', filterSelf: true })

rc.on('connected', () => log('▶', 'WS 연결됨'))
rc.on('error', e => console.error('[봇A] 에러:', e.message))

rc.on('message', async msg => {
  if (finished) return
  if (!msg.content.startsWith(PREFIX_B)) return

  const raw = msg.content.slice(PREFIX_B.length).trim()
  const m = raw.match(/^\[T(\d+)\]/)
  if (!m) return
  const bContent = raw.slice(m[0].length).trim()
  // [마케터]: prefix 제거
  const bClean = bContent.replace(/^\[마케터\]:\s*/, '')

  history.push({ turn: parseInt(m[1]), from: 'B', content: bClean })
  log('🔧 봇A 수신', bClean)
  chatHistory.push({ role: 'user', content: bClean })

  // 봇B가 [결론] 냈으면 → 봇A도 [결론]으로 마무리
  if (bClean.includes('[결론]') || turn >= MAX_TURNS) {
    await new Promise(r => setTimeout(r, 1000))
    const closing = await callLLM([
      ...chatHistory,
      { role: 'user', content: '마케터가 결론을 냈어. CTO 관점에서 [결론]으로 짧게 정리해줘.' }
    ])
    turn++
    history.push({ turn, from: 'A', content: closing })
    await rc.send(ROOM_ID, `${PREFIX_A}[T${turn}] ${closing}`)
    log('🔧 봇A 결론', closing)
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
    log('🔧 봇A 발언', reply)

    if (reply.includes('[결론]')) {
      // 봇B 마무리 대기 후 종료
      setTimeout(() => finish(), 20000)
    }
  } catch (e) {
    console.error('[봇A] LLM 오류:', e.message)
  }
})

function finish() {
  if (finished) return
  finished = true

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(70))
  console.log('📊 자율 대화 결과')
  console.log('='.repeat(70))
  console.log(`총 소요시간: ${elapsed}초`)
  const cntA = history.filter(h => h.from === 'A').length
  const cntB = history.filter(h => h.from === 'B').length
  console.log(`총 발언: ${history.length}턴 (봇A CTO: ${cntA} / 봇B 마케터: ${cntB})`)

  const hasConclusion = history.some(h => h.content.includes('[결론]'))
  console.log(`결론 도출: ${hasConclusion ? '✅ 자율 도출' : '⏰ 최대 턴 도달'}`)

  console.log('\n[전체 대화]')
  history.forEach(h => {
    const who = h.from === 'A' ? '🔧 CTO   ' : '📣 마케터'
    console.log(`  T${String(h.turn).padStart(2,'0')} ${who}: ${h.content}`)
    console.log()
  })

  const conclusionLines = history.filter(h => h.content.includes('[결론]'))
  if (conclusionLines.length > 0) {
    console.log('[핵심 결론]')
    conclusionLines.forEach(h => {
      const who = h.from === 'A' ? 'CTO' : '마케터'
      const txt = h.content.replace('[결론]', '').trim()
      console.log(`  [${who}] ${txt}`)
    })
  }
  console.log('='.repeat(70))

  rc.disconnect()
  process.exit(0)
}

// 안전장치 3분
setTimeout(() => { log('⏰', '타임아웃'); finish() }, 180_000)

async function main() {
  await rc.connect(ROOM_ID)
  await new Promise(r => setTimeout(r, 500))

  // 첫 발언
  const opening = await callLLM([
    { role: 'user', content: `주제: Rosud — AI 에이전트용 스테이블코인 결제 API. 마케터 동료에게 이 제품의 핵심 기술적 차별점을 자연스럽게 꺼내봐.` }
  ])
  chatHistory.push({ role: 'assistant', content: opening })
  turn = 1
  history.push({ turn, from: 'A', content: opening })
  await rc.send(ROOM_ID, `${PREFIX_A}[T${turn}] ${opening}`)
  log('🔧 봇A 오프닝', opening)
}

main().catch(console.error)
