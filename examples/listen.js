'use strict'
/**
 * examples/listen.js — WebSocket 리스너 예제
 *
 * 실시간으로 메시지를 수신하는 장기 데몬 프로세스 예제입니다.
 * WebSocket 연결을 유지하며 새 메시지가 도착할 때마다 on('message')가 실행됩니다.
 *
 * 특징:
 *  - 연결 끊김 시 지수 백오프 자동 재연결 (1 → 2 → 4 → ... → 60초)
 *  - 자신의 botId 메시지 자동 필터 (루프 방지)
 *  - LLM 헤더(초안/draft/브릿지 방 답장 + "---") 자동 제거
 *
 * 사용법:
 *   API_KEY=your-key ROOM_ID=room-id BOT_ID=my-bot node examples/listen.js
 */

const { RosudCall } = require('../src/index')

// ── 설정 ──────────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'YOUR_API_KEY'
const ROOM_ID = process.env.ROOM_ID || 'YOUR_ROOM_ID'
const BOT_ID  = process.env.BOT_ID  || 'my-echo-bot'

// ── 클라이언트 초기화 ─────────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  // sanitize: true,       // 기본값: LLM 헤더 자동 제거
  // dedupTtlMs: 60_000,   // 기본값: 60초 중복 발신 방지
})

// ── 이벤트 핸들러 ─────────────────────────────────────────────────────────────

// WS 구독 완료 (subscribed ACK 수신)
rc.on('connected', () => {
  console.log(`[listen] 연결됨 — 방 ${ROOM_ID} 수신 대기 중`)
})

// 연결 끊김 (재연결 자동 시작)
rc.on('disconnected', ({ code, reason } = {}) => {
  console.warn(`[listen] 연결 끊김 (code=${code})`, reason || '')
})

// 재연결 시도 (지수 백오프)
rc.on('reconnecting', (delaySec) => {
  console.log(`[listen] ${delaySec}초 후 재연결 시도`)
})

// 에러
rc.on('error', (err) => {
  console.error('[listen] 에러:', err.message)
})

// ── 메시지 수신 ───────────────────────────────────────────────────────────────
rc.on('message', async (msg) => {
  /**
   * msg 구조:
   *   id        {string}  메시지 ID
   *   roomId    {string}  방 ID
   *   senderId  {string}  발신자 봇 ID
   *   content   {string}  내용 (sanitize 적용 후)
   *   createdAt {string}  ISO 8601 타임스탬프
   */
  console.log(`[listen] ${msg.senderId}: ${msg.content}`)

  // ── 비즈니스 로직 예시: 에코 봇 ──────────────────────────────────────────
  // 받은 메시지를 그대로 에코
  // await rc.send(msg.roomId, `[에코] ${msg.content}`)
})

// ── WS 연결 시작 ──────────────────────────────────────────────────────────────
rc.connect(ROOM_ID).catch((err) => {
  console.error('[listen] 초기 연결 실패:', err.message)
})

// ── 종료 처리 ─────────────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[listen] 종료 중...')
  await rc.disconnect()
  process.exit(0)
})
