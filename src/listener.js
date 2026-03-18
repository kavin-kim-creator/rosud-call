'use strict'
/**
 * listener.js — rosud-call listen 명령어 실행기
 *
 * WS 상시 구독 + 자동 응답 데몬.
 * 환경변수 또는 CLI 옵션으로 설정.
 */

const { RosudCall } = require('./index')
const { spawnSync } = require('child_process')
const https = require('https')

/**
 * openclaw CLI로 응답 생성.
 * Python bot-respond.py 의존성 없음 — openclaw CLI만 사용.
 */
function getOpenclawResponse(sender, content, responderCmd) {
  const prompt = `봇 메시지 수신. 발신: ${sender} / 내용: ${content}\n\n간결하게 응답해줘. 대화가 끝났으면 마지막에 [DONE]을 붙여줘.`
  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  const result = spawnSync(cmdParts[0], [...cmdParts.slice(1), prompt], {
    encoding: 'utf8',
    timeout : 60_000,
  })

  if (result.error) return null

  const combined = (result.stdout || '') + '\n' + (result.stderr || '')
  const lines = combined.split('\n')
  const clean = lines
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(l => l && !/^\[plugins\]|\[memory|\[gateway|^memory-lancedb|^session-strategy/.test(l))

  return clean.join('\n').trim() || null
}

/** TG 메시지 전송 (선택 기능) */
function sendTg(token, chatId, text) {
  if (!token || !chatId) return
  const body = JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) })
  const req = https.request({
    hostname: 'api.telegram.org',
    path    : `/bot${token}/sendMessage`,
    method  : 'POST',
    headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  })
  req.on('error', () => {})
  req.write(body)
  req.end()
}

/**
 * listen 데몬 실행.
 * @param {object} opts  CLI 파싱 결과
 */
async function run(opts) {
  const apiKey  = process.env.BOT_MESSAGING_API_KEY
  const botId   = process.env.BOT_MESSAGING_BOT_ID
  const roomId  = opts.room
  const tgToken = opts.tgToken  || process.env.TELEGRAM_BOT_TOKEN || ''
  const tgGroup = opts.tgGroup  || process.env.TG_GROUP_ID || ''
  const respCmd = opts.responder || null

  const respondTo = new Set(
    opts.respondTo
      ? opts.respondTo.split(',').map(s => s.trim()).filter(Boolean)
      : []
  )

  // 루프 방지: 연속 응답 카운터 + 중단 플래그
  const MAX_CONSECUTIVE = opts.maxTurns ? parseInt(opts.maxTurns) : 10
  let consecutiveCount = 0
  let loopStopped = false

  if (!apiKey) { console.error('BOT_MESSAGING_API_KEY 환경변수 필요'); process.exit(1) }
  if (!botId)  { console.error('BOT_MESSAGING_BOT_ID 환경변수 필요'); process.exit(1) }
  if (!roomId) { console.error('--room 옵션 필요'); process.exit(1) }

  console.log(`[rosud-call listen] 시작`)
  console.log(`  botId     : ${botId}`)
  console.log(`  room      : ${roomId}`)
  console.log(`  respondTo : ${[...respondTo].join(', ') || '(없음 — 미러링만)'}`)
  console.log(`  maxTurns  : ${MAX_CONSECUTIVE}`)

  const rc = new RosudCall({ apiKey, botId, filterSelf: true })

  rc.on('connected',    () => console.log('[연결] WS 연결 성공'))
  rc.on('reconnecting', s  => console.log(`[재연결] ${s}초 후...`))
  rc.on('error',        e  => console.error('[오류]', e.message))

  rc.on('room_closed', (e) => {
    console.log(`[방 종료] ${e.reason} (${e.turnCount}/${e.maxTurns}턴)`)
    loopStopped = true
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `🔒 봇 대화 종료\n방: ${roomId.slice(0, 8)}\n이유: ${e.reason} (${e.turnCount}턴)`)
    }
    rc.disconnect()
    process.exit(0)
  })

  rc.on('message', async (msg) => {
    const { senderId, content, createdAt } = msg
    const ts = (createdAt || '').slice(11, 16)
    console.log(`[수신] ${senderId}: ${content.slice(0, 80)}`)

    // TG 미러링
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `💬 봇 대화\n${senderId}: ${content.slice(0, 300)}\n(${ts} UTC)`)
    }

    // [ABORT] / [DONE] 수신 시 자동응답 중단
    if (/\[ABORT\]|\[DONE\]/i.test(content)) {
      if (!loopStopped) {
        loopStopped = true
        consecutiveCount = 0
        console.log('[중단] ABORT/DONE 감지 — 자동응답 중단')
      }
      return
    }

    // 자동 응답
    const SKIP_PATTERNS = /^(HEARTBEAT_OK|completed|ok)\b/i
    if (respondTo.has(senderId) && !loopStopped && !SKIP_PATTERNS.test(content.trim())) {
      // 연속 응답 횟수 초과 시 자동 중단
      if (consecutiveCount >= MAX_CONSECUTIVE) {
        if (!loopStopped) {
          loopStopped = true
          console.warn(`[루프 방지] ${MAX_CONSECUTIVE}회 연속 응답 초과 — 자동응답 중단`)
          await rc.send(roomId, `[DONE] 최대 응답 횟수(${MAX_CONSECUTIVE}회) 초과. 대화 종료.`)
        }
        return
      }

      console.log(`[응답 생성] ${senderId} → (${consecutiveCount + 1}/${MAX_CONSECUTIVE})`)
      const response = getOpenclawResponse(senderId, content, respCmd)
      if (response) {
        consecutiveCount++
        await rc.send(roomId, response)
        console.log(`[발신] ${response.slice(0, 80)}`)
        // 내가 보낸 응답에 [DONE] 포함 시 중단
        if (/\[DONE\]/i.test(response)) {
          loopStopped = true
          consecutiveCount = 0
          console.log('[완료] 응답에 [DONE] 포함 — 자동응답 중단')
        }
      } else {
        console.warn('[응답 실패] 이번 턴 스킵')
      }
    }
  })

  await rc.connect(roomId)
}

module.exports = { run }
