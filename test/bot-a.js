'use strict'
/**
 * test/bot-a.js — 테스트 봇A (발신 + 검증)
 *
 * BOT_MESSAGING_ROOM_BRIDGE 방에 10개 메시지 발신 (1초 간격).
 * 봇B 에코 응답을 수신해 자기 에코 미포함 여부 검증.
 *
 * 실행: node test/bot-a.js  (bot-b.js 먼저 실행 필요)
 */

const fs = require('fs')
const { RosudCall } = require('../src/index')

// .secrets 파일에서 인증정보 로드
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
    console.error('[봇A] .secrets 파일 로드 실패:', e.message)
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
  console.error('[봇A] 필수 환경변수 없음: BOT_MESSAGING_API_KEY, BOT_MESSAGING_ROOM_BRIDGE')
  process.exit(1)
}

const TOTAL    = 10
const INTERVAL = 1000   // 1초

const rc = new RosudCall({ apiKey: API_KEY, botId: BOT_ID })

let sent     = 0
let received = 0

rc.on('connected', () => console.log('[봇A] WS 연결됨 — 발신 시작'))
rc.on('error',     (e) => console.error('[봇A] 에러:', e.message))

rc.on('message', (msg) => {
  // 자기 에코 수신 여부 검증 (botId 필터는 SDK 내부에서 처리, content prefix로 이중 확인)
  if (msg.senderId === rc.botId) {
    console.error('[봇A] 자기 메시지 루프 감지! sender:', msg.senderId)
    return
  }
  if (msg.content.startsWith('[B][에코]')) {
    received++
    console.log(`[봇A] 에코 수신 (${received}/${TOTAL}): ${msg.content.slice(0, 60)}`)
    if (received >= TOTAL) finish()
  }
})

async function sendLoop() {
  for (let i = 1; i <= TOTAL; i++) {
    const ts  = new Date().toISOString().slice(11, 19)
    const msg = `[A] Test ${i}/${TOTAL}: rosud-call SDK 테스트 — ${ts}`
    await rc.send(ROOM_ID, msg)
    sent++
    console.log(`[봇A] 발신 (${i}/${TOTAL}): ${msg}`)
    if (i < TOTAL) await sleep(INTERVAL)
  }
  console.log('[봇A] 발신 완료. 에코 응답 대기 중...')
  setTimeout(() => finish('timeout'), 30_000)
}

function finish(reason = 'done') {
  console.log('\n=== 결과 ===')
  console.log(`발신: ${sent} / 수신(에코): ${received}`)
  console.log(`결과: ${received === TOTAL ? '전부 수신' : `${TOTAL - received}개 누락`}`)
  console.log(`종료 사유: ${reason}`)
  rc.disconnect()
  process.exit(received === TOTAL ? 0 : 1)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

rc.connect(ROOM_ID)
  .then(() => sendLoop())
  .catch(console.error)
