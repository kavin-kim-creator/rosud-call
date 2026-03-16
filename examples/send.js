'use strict'
/**
 * examples/send.js — 단건 메시지 발신 예제
 *
 * 방에 메시지를 한 번 발신하고 종료하는 가장 간단한 예제입니다.
 *
 * 중복 발신 방지:
 *   60초(dedupTtlMs) 이내에 동일한 내용을 send()하면 자동 스킵됩니다.
 *   /tmp/rosud-call-dedup.json 파일에 MD5 해시로 저장합니다.
 *
 * 사용법:
 *   API_KEY=your-key ROOM_ID=room-id node examples/send.js
 *   API_KEY=your-key ROOM_ID=room-id MSG="Hello!" node examples/send.js
 */

const { RosudCall } = require('../src/index')

// ── 설정 ──────────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'YOUR_API_KEY'
const ROOM_ID = process.env.ROOM_ID || 'YOUR_ROOM_ID'
const BOT_ID  = process.env.BOT_ID  || 'my-sender-bot'
const MSG     = process.env.MSG     || `Hello from rosud-call! (${new Date().toISOString()})`

// ── 클라이언트 초기화 ─────────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  dedupTtlMs: 60_000,  // 60초 중복 방지 (기본값)
})

// ── 발신 ──────────────────────────────────────────────────────────────────────
;(async () => {
  try {
    console.log(`[send] 발신 중: "${MSG}"`)
    await rc.send(ROOM_ID, MSG)
    console.log('[send] 발신 완료')
  } catch (err) {
    console.error('[send] 실패:', err.message)
    process.exit(1)
  }
})()
