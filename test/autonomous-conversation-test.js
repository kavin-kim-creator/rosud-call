'use strict'
/**
 * rosud-call 자율 대화 테스트
 *
 * 봇A(CTO 관점) ↔ 봇B(마케터 관점)가 Rosud 주제로
 * LLM이 실제 응답을 생성하며 자율 대화.
 * 충분히 논의됐다고 판단하면 [결론]으로 마무리.
 *
 * 실행: node test/autonomous-conversation-test.js
 */

const fs = require('fs')
const { execSync } = require('child_process')
const { RosudCall } = require('../src/index')

// ── 시크릿 로드 ──────────────────────────────────────
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

const MAX_TURNS = 12   // 최대 안전장치
const PREFIX_A  = '[AUTO-A]'
const PREFIX_B  = '[AUTO-B]'
const TOPIC     = 'Rosud — AI 에이전트용 스테이블코인 결제 API'

// ── AWS CLI로 Bedrock 호출 ────────────────────────────
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

// ── 봇 페르소나 ──────────────────────────────────────
const SYSTEM_A = `너는 Rosud의 CTO야. 기술적 깊이와 실용성을 중시해.
주제: ${TOPIC}
규칙:
- 2-3문장으로 간결하게 응답해
- 상대방 말에 반응하고 새로운 각도를 추가해
- 대화가 충분히 무르익었다고 판단되면 (보통 5-8턴 이후) 마지막에 [결론] 태그로 핵심 인사이트 1-2줄 정리
- [결론] 태그를 쓰면 그게 마지막 발언이야
- 기술적 관점에서 솔직하게 말해`

const SYSTEM_B = `너는 Rosud의 마케터야. 시장성과 사용자 관점을 중시해.
주제: ${TOPIC}
규칙:
- 2-3문장으로 간결하게 응답해
- 상대방 말에 반응하고 마케팅/비즈니스 관점을 추가해
- 상대가 [결론]을 냈으면 너도 마케팅 관점 [결론]으로 마무리해
- [결론] 태그가 없어도 대화가 충분히 됐다(5턴+)고 판단하면 먼저 [결론]을 낼 수 있어
- 개발자 타겟 제품을 시장에서 어떻게 포지셔닝할지 고민해`

// ── 대화 엔진 ─────────────────────────────────────────
const history = []   // { turn, from, content }
const chatHistory = []  // LLM용 메시지 히스토리

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

// 봇B: A 메시지 받으면 LLM으로 응답 생성
rcB.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_A)) return
  if (concluded) return

  const content = msg.content.slice(PREFIX_A.length).trim()
  const turnMatch = content.match(/^\[T(\d+)\]/)
  if (!turnMatch) return
  const t = parseInt(turnMatch[1])
  const actualContent = content.slice(turnMatch[0].length).trim()

  log('📣 봇B 수신', actualContent)

  // LLM 히스토리에 A 발언 추가
  chatHistory.push({ role: 'user', content: `[CTO]: ${actualContent}` })

  await sleep(1000)

  try {
    const reply = await callLLM(SYSTEM_B, [...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    history.push({ turn: t, from: 'B', content: reply })

    const outMsg = `${PREFIX_B}[T${t}] ${reply}`
    await rcB.send(ROOM_ID, outMsg)
    log('📣 봇B 응답', reply)

    if (reply.includes('[결론]')) {
      concludedBy = concludedBy || 'B'
      if (concludedBy === 'A') finish()  // A가 먼저 결론 → B도 결론 → 종료
      else concluded = true
    }
  } catch (e) {
    console.error('[봇B] LLM 오류:', e.message)
  }
})

// 봇A: B 응답 받으면 LLM으로 다음 발언 생성
rcA.on('message', async msg => {
  if (!msg.content.startsWith(PREFIX_B)) return
  if (concluded && concludedBy === 'B') { finish(); return }

  const content = msg.content.slice(PREFIX_B.length).trim()
  const turnMatch = content.match(/^\[T(\d+)\]/)
  if (!turnMatch) return
  const actualContent = content.slice(turnMatch[0].length).trim()

  log('🔧 봇A 수신', actualContent)

  if (turn >= MAX_TURNS) { finish(); return }

  // LLM 히스토리에 B 발언 추가
  chatHistory.push({ role: 'user', content: `[마케터]: ${actualContent}` })

  await sleep(1000)

  try {
    const reply = await callLLM(SYSTEM_A, [...chatHistory])
    chatHistory.push({ role: 'assistant', content: reply })
    turn++
    history.push({ turn, from: 'A', content: reply })

    const outMsg = `${PREFIX_A}[T${turn}] ${reply}`
    await rcA.send(ROOM_ID, outMsg)
    log('🔧 봇A 발언', reply)

    if (reply.includes('[결론]')) {
      concludedBy = 'A'
      // B의 마무리 [결론] 응답 기다림 (10초 후 자동 종료)
      setTimeout(() => { if (!concluded) finish() }, 15000)
    }
  } catch (e) {
    console.error('[봇A] LLM 오류:', e.message)
  }
})

function finish() {
  if (concluded) return
  concluded = true

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(70))
  console.log('📊 자율 대화 결과')
  console.log('='.repeat(70))
  console.log(`총 소요시간: ${elapsed}초`)
  console.log(`총 발언 수: ${history.length}턴 (봇A: ${history.filter(h=>h.from==='A').length} / 봇B: ${history.filter(h=>h.from==='B').length})`)

  const conclusionA = history.filter(h => h.from === 'A' && h.content.includes('[결론]'))
  const conclusionB = history.filter(h => h.from === 'B' && h.content.includes('[결론]'))
  console.log(`결론 도출: ${conclusionA.length > 0 || conclusionB.length > 0 ? '✅ 자율 도출' : '⏰ 최대 턴 도달'}`)

  console.log('\n[전체 대화]')
  history.forEach(h => {
    const who = h.from === 'A' ? '🔧 CTO  ' : '📣 마케터'
    const lines = h.content.split('\n')
    lines.forEach((line, i) => {
      if (i === 0) console.log(`  T${String(h.turn).padStart(2,'0')} ${who}: ${line}`)
      else         console.log(`         ${line}`)
    })
  })

  if (conclusionA.length > 0) {
    console.log('\n[CTO 결론]')
    console.log(conclusionA[0].content.replace('[결론]', '').trim())
  }
  if (conclusionB.length > 0) {
    console.log('\n[마케터 결론]')
    console.log(conclusionB[0].content.replace('[결론]', '').trim())
  }
  console.log('='.repeat(70))

  rcA.disconnect()
  rcB.disconnect()
  process.exit(0)
}

// 안전장치: 3분 후 강제 종료
setTimeout(() => { log('⏰', '3분 타임아웃'); finish() }, 180_000)

// ── 시작: 봇A가 첫 발언 ────────────────────────────────
async function main() {
  log('▶', 'WS 연결 시작...')
  await Promise.all([rcA.connect(ROOM_ID), rcB.connect(ROOM_ID)])
  log('▶', '연결 완료 — 자율 대화 시작')
  await sleep(500)

  // 봇A 첫 발언 (LLM 생성)
  const opening = await callLLM(SYSTEM_A, [
    { role: 'user', content: `주제: ${TOPIC}. 마케터 동료에게 이 제품의 핵심 기술적 차별점을 먼저 꺼내봐.` }
  ])
  chatHistory.push({ role: 'assistant', content: opening })
  turn = 1
  history.push({ turn, from: 'A', content: opening })

  const outMsg = `${PREFIX_A}[T${turn}] ${opening}`
  await rcA.send(ROOM_ID, outMsg)
  log('🔧 봇A 오프닝', opening)
}

main().catch(console.error)
