'use strict'
/**
 * examples/poll.js — REST 폴링 예제
 *
 * crontab 또는 짧은 주기 스케줄러에서 호출하는 단기 실행 스크립트 예제입니다.
 * 실행할 때마다 마지막으로 처리한 메시지 ID(/tmp/rosud-call-state.json) 이후
 * 새 메시지만 가져와 on('message')를 emit 합니다.
 *
 * 커서 파일 형식:
 *   /tmp/rosud-call-state.json → { "roomId": "last-message-id" }
 *
 * 첫 실행 시:
 *   현재 최신 ID를 저장하고 즉시 종료 (과거 메시지 재전송 방지)
 *
 * 사용법:
 *   API_KEY=your-key ROOM_ID=room-id BOT_ID=my-bot node examples/poll.js
 *
 * crontab 예시 (30초마다):
 *   * * * * * /usr/bin/node /path/to/examples/poll.js
 *   * * * * * sleep 30; /usr/bin/node /path/to/examples/poll.js
 */

const { RosudCall } = require('../src/index')

// ── 설정 ──────────────────────────────────────────────────────────────────────
const API_KEY    = process.env.API_KEY    || 'YOUR_API_KEY'
const ROOM_ID    = process.env.ROOM_ID    || 'YOUR_ROOM_ID'
const BOT_ID     = process.env.BOT_ID     || 'my-poll-bot'
const STATE_FILE = process.env.STATE_FILE || '/tmp/rosud-call-state.json'

// ── 클라이언트 초기화 ─────────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  // skipSenders: ['other-bot'],  // 이 봇들의 메시지 무시
})

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────
rc.on('message', async (msg) => {
  /**
   * msg 구조:
   *   id, roomId, senderId, content, createdAt
   */
  console.log(`[poll] ${msg.senderId}: ${msg.content}`)

  // ── 비즈니스 로직 예시 ────────────────────────────────────────────────────
  // 특정 발신자의 메시지에만 응답
  // if (msg.senderId === 'target-bot') {
  //   await rc.send(msg.roomId, `처리 완료: ${msg.content}`)
  // }
})

// ── 폴링 실행 ─────────────────────────────────────────────────────────────────
;(async () => {
  try {
    await rc.poll(ROOM_ID, {
      stateFile: STATE_FILE,
      limit: 200,
    })
    console.log('[poll] 완료')
  } catch (err) {
    console.error('[poll] 에러:', err.message)
    process.exit(1)
  }
})()
