'use strict'
/**
 * rosud-call 5턴 대화 테스트
 * 봇A ↔ 봇B가 Rosud 주제로 5턴 이어서 대화
 * 맥락 유지 확인 + 메시지 전달 확인
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

// 봇A 대화 주제 (맥락 체인용)
const BOT_A_TURNS = [
  '안녕 봇B! Rosud 제품 테스트야. rosud-call SDK가 뭔지 한 줄로 설명해줘.',
  '그럼 WS 연결 방식이랑 REST 폴링 방식 중 어떤 게 더 좋아?',
  'WS가 실시간이라는 건 알겠는데, 재연결 로직은 어떻게 처리돼?',
  '알겠어. 그럼 지금 이 대화처럼 봇끼리 맥락을 유지하면서 대화하는 게 rosud-call로 가능한 거야?',
  '완벽해! 마지막으로, 이 SDK를 외부 개발자한테 추천할 만한 이유 하나만 말해줘.'
]

// 봇B 응답 (각 턴에 맞는 맥락 유지 응답)
const BOT_B_RESPONSES = [
  'rosud-call은 AI 봇들이 WebSocket으로 실시간 메시지를 주고받는 SDK야 — npm install rosud-call 하나면 끝.',
  'WS가 단연 낫지. REST는 폴링이라 지연이 있고, WS는 지금 우리처럼 즉시 전달돼.',
  '지수 백오프로 자동 재연결해. 연결 끊겨도 메시지 큐에 쌓았다가 복구되면 전송해줘.',
  '응, 정확해! dedup + sanitizer가 내장돼 있어서 중복 메시지나 헤더 노출 걱정 없이 맥락 유지 대화가 가능해.',
  '설치가 진짜 쉬워서 — npm install rosud-call, API 키 하나, 그게 전부야. 복잡한 인프라 필요 없어.'
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

// ── 봇B: A 메시지 수신 → 맥락 응답 ──────────────────
rcB.on('message', async (msg) => {
  if (!msg.content.startsWith(PREFIX_A)) return
  // 이미 처리한 턴인지 확인
  const turnMatch = msg.content.match(/\[T(\d+)\]/)
  if (!turnMatch) return
  const turn = parseInt(turnMatch[1])
  if (turn !== turnB + 1) return

  log(`📣 봇B 수신 (T${turn})`, msg.content.slice(PREFIX_A.length + 6))

  await sleep(800) // 봇이 "생각"하는 시간

  const reply = `${PREFIX_B}[T${turn}] ${BOT_B_RESPONSES[turn - 1]}`
  history.push({ turn, from: 'B', content: BOT_B_RESPONSES[turn - 1] })
  await rcB.send(ROOM_ID, reply)
  log(`📣 봇B 발신 (T${turn})`, BOT_B_RESPONSES[turn - 1])
  turnB++
})

// ── 봇A: B 응답 수신 → 다음 턴 발신 ─────────────────
rcA.on('message', async (msg) => {
  if (!msg.content.startsWith(PREFIX_B)) return
  const turnMatch = msg.content.match(/\[T(\d+)\]/)
  if (!turnMatch) return
  const turn = parseInt(turnMatch[1])
  if (turn !== turnA) return // 현재 턴 응답인지 확인

  log(`🔧 봇A 수신 응답 (T${turn})`, msg.content.slice(PREFIX_B.length + 6))

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
  log(`🔧 봇A 발신 (T${turnA})`, BOT_A_TURNS[turnA - 1])
}

function finish() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('\n' + '='.repeat(60))
  console.log('📊 대화 테스트 결과')
  console.log('='.repeat(60))
  console.log(`총 소요시간: ${elapsed}초`)
  console.log(`봇A 발신: ${turnA}턴 | 봇B 응답: ${turnB}턴`)
  console.log(`맥락 유지: ${turnA === MAX_TURNS && turnB === MAX_TURNS ? '✅ 성공 (5/5 전체 완료)' : '❌ 일부 누락'}`)
  console.log('\n[대화 히스토리]')
  history.forEach(h => {
    const who = h.from === 'A' ? '🔧 봇A' : '📣 봇B'
    console.log(`  T${h.turn} ${who}: ${h.content}`)
  })
  console.log('='.repeat(60))

  rcA.disconnect()
  rcB.disconnect()
  process.exit(turnA === MAX_TURNS && turnB === MAX_TURNS ? 0 : 1)
}

// 타임아웃 60초
setTimeout(() => {
  log('⏰', '타임아웃 — 강제 종료')
  finish()
}, 60_000)

// ── 시작 ─────────────────────────────────────────────
async function main() {
  log('▶', 'WS 연결 시작...')
  await Promise.all([
    rcA.connect(ROOM_ID),
    rcB.connect(ROOM_ID)
  ])
  log('▶', '봇A, 봇B 연결 완료 — 첫 번째 턴 시작')
  await sleep(500)
  await sendNextTurn()
}

main().catch(console.error)
