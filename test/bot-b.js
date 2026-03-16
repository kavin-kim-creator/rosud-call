'use strict'
/**
 * test/bot-b.js — 테스트 봇B (수신 + 에코)
 *
 * BOT_MESSAGING_ROOM_BRIDGE 방 구독.
 * 수신 메시지를 "[B][에코] {content}" 로 응답.
 * 60초 후 자동 종료.
 *
 * 실행: node test/bot-b.js  (bot-a.js 보다 먼저 실행)
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
    console.error('[봇B] .secrets 파일 로드 실패:', e.message)
    process.exit(1)
  }
  return secrets
}

const SECRETS_PATH = '/home/kasm-user/.openclaw/workspace/.secrets'
const s = loadSecrets(SECRETS_PATH)

const API_KEY = s.BOT_MESSAGING_API_KEY
const ROOM_ID = s.BOT_MESSAGING_ROOM_BRIDGE
// 봇A와 다른 bot_id 사용 (같은 API 키도 bot_id로 구분)
const BOT_ID  = 'kavin-desktop-general-work'

if (!API_KEY || !ROOM_ID) {
  console.error('[봇B] 필수 환경변수 없음: BOT_MESSAGING_API_KEY, BOT_MESSAGING_ROOM_BRIDGE')
  process.exit(1)
}

const rc = new RosudCall({ apiKey: API_KEY, botId: BOT_ID })

rc.on('connected',    ()    => console.log('[봇B] WS 연결됨'))
rc.on('disconnected', ()    => console.log('[봇B] 연결 끊김'))
rc.on('reconnecting', (sec) => console.log(`[봇B] ${sec}초 후 재연결`))
rc.on('error',        (err) => console.error('[봇B] 에러:', err.message))

rc.on('message', async (msg) => {
  console.log(`[봇B] 수신: ${msg.senderId} → ${msg.content.slice(0, 60)}`)

  if (msg.content.startsWith('[A]')) {
    const reply = `[B][에코] ${msg.content}`
    await rc.send(ROOM_ID, reply)
    console.log(`[봇B] 에코 발신: ${reply.slice(0, 60)}`)
  }
})

console.log('[봇B] 시작 — 봇A 메시지 대기 중... (60초 후 자동 종료)')
rc.connect(ROOM_ID).catch(console.error)

// 60초 후 자동 종료
setTimeout(() => {
  console.log('[봇B] 60초 경과 — 자동 종료')
  rc.disconnect()
  process.exit(0)
}, 60_000)
