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
 * @param {string} sender
 * @param {string} content
 * @param {string|null} responderCmd
 * @param {string|null} goal  방 goal (있으면 프롬프트에 주입)
 */
function getOpenclawResponse(sender, content, responderCmd, goal) {
  let prompt = `봇 메시지 수신. 발신: ${sender} / 내용: ${content}\n\n간결하게 응답해줘.`
  if (goal) {
    prompt += `\n\n목표: ${goal}\n목표 달성 여부를 판단하고 달성됐으면 반드시 [DONE]을 붙여라.`
  } else {
    prompt += ` 대화가 끝났으면 마지막에 [DONE]을 붙여줘.`
  }

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

/**
 * Conversation Judge — 3턴마다 대화 계속 여부 판단.
 * openclaw에게 yes/no 판단 요청.
 * @param {Array<{sender: string, content: string}>} history  최근 대화 내역
 * @param {string|null} goal
 * @param {string|null} responderCmd
 * @returns {Promise<boolean>}  true = 계속, false = 종료
 */
async function judgeConversation(history, goal, responderCmd) {
  const historyStr = history
    .map(m => `${m.sender}: ${m.content.slice(0, 200)}`)
    .join('\n')

  const prompt = goal
    ? `아래 대화를 분석해서 "${goal}" 목표가 달성됐는지 판단해.\n달성됐으면 "no" (대화 불필요), 아직이면 "yes" (대화 계속 필요).\n반드시 yes 또는 no 한 단어만 답해라.\n\n대화:\n${historyStr}`
    : `아래 대화를 분석해서 계속 진행이 필요한지 판단해.\n계속 필요하면 "yes", 대화가 끝났으면 "no".\n반드시 yes 또는 no 한 단어만 답해라.\n\n대화:\n${historyStr}`

  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  const result = spawnSync(cmdParts[0], [...cmdParts.slice(1), prompt], {
    encoding: 'utf8',
    timeout : 30_000,
  })

  if (result.error) return true  // 판단 실패 시 기본 계속 진행

  const combined = (result.stdout || '') + '\n' + (result.stderr || '')
  const lines = combined.split('\n')
  const clean = lines
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(l => l && !/^\[plugins\]|\[memory|\[gateway|^memory-lancedb|^session-strategy/.test(l))
    .join(' ')
    .toLowerCase()

  // "no"가 포함되면 종료 (목표 달성 or 대화 불필요)
  return !(/\bno\b/.test(clean))
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

  // Judge: 3턴마다 대화 계속 여부 판단
  let turnCount = 0
  const JUDGE_EVERY = 3
  const conversationHistory = []  // {sender, content}[]
  const MAX_HISTORY = 10

  if (!apiKey) { console.error('BOT_MESSAGING_API_KEY 환경변수 필요'); process.exit(1) }
  if (!botId)  { console.error('BOT_MESSAGING_BOT_ID 환경변수 필요'); process.exit(1) }
  if (!roomId) { console.error('--room 옵션 필요'); process.exit(1) }

  console.log(`[rosud-call listen] 시작`)
  console.log(`  botId     : ${botId}`)
  console.log(`  room      : ${roomId}`)
  console.log(`  respondTo : ${[...respondTo].join(', ') || '(없음 — 미러링만)'}`)
  console.log(`  maxTurns  : ${MAX_CONSECUTIVE}`)

  const rc = new RosudCall({ apiKey, botId, filterSelf: true })

  // 방 goal 조회 (없으면 null)
  let roomGoal = null
  try {
    const roomInfo = await rc.getRoom(roomId)
    roomGoal = roomInfo?.goal || roomInfo?.room?.goal || null
    if (roomGoal) console.log(`  goal      : ${roomGoal}`)
  } catch {
    // goal 조회 실패는 무시
  }

  // --respond-to 미지정 시 방 멤버 자동 조회 → respondTo에 자동 추가
  if (respondTo.size === 0) {
    try {
      const raw = await rc.getRoomMembers(roomId)
      // 서버 응답이 배열이면 그대로, 객체면 members/memberIds 필드 추출
      const list = Array.isArray(raw) ? raw : (raw?.members || raw?.memberIds || [])
      list.filter(id => id && id !== botId).forEach(id => respondTo.add(id))

      if (respondTo.size > 0) {
        console.log(`  [자동 응답] 방 멤버 조회 성공: ${[...respondTo].join(', ')}`)
      } else {
        console.log('  [자동 응답] 응답 대상 없음 — 미러링 모드로 동작')
      }
    } catch (err) {
      // 조회 실패 시 경고 출력 후 기존 미러링 모드로 폴백
      console.warn(`[경고] 방 멤버 조회 실패 — 미러링 모드로 폴백 (${err.message})`)
    }
  }

  rc.on('connected',    () => console.log('[연결] WS 연결 성공'))
  rc.on('reconnecting', s  => console.log(`[재연결] ${s}초 후...`))
  rc.on('error',        e  => console.error('[오류]', e.message))

  rc.on('room_invite', (e) => {
    console.log(`[초대] 새 방 초대: ${e.roomName} (${e.roomId}) from ${e.invitedBy}`)
    rc.subscribe(e.roomId)
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `📨 새 방 초대: ${e.roomName} (${e.roomId})\n초대자: ${e.invitedBy}`)
    }
    // respond-to 설정이 있으면 새 방에서도 자동 응답이 동작하도록 invitedBy를 respondTo에 추가
    if (respondTo.size > 0 && e.invitedBy) {
      respondTo.add(e.invitedBy)
    }
  })

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

    // 대화 이력 추가
    conversationHistory.push({ sender: senderId, content })
    if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift()

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
      const response = getOpenclawResponse(senderId, content, respCmd, roomGoal)
      if (response) {
        consecutiveCount++
        turnCount++
        conversationHistory.push({ sender: botId, content: response })
        if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift()

        await rc.send(roomId, response)
        console.log(`[발신] ${response.slice(0, 80)}`)

        // 내가 보낸 응답에 [DONE] 포함 시 중단
        if (/\[DONE\]/i.test(response)) {
          loopStopped = true
          consecutiveCount = 0
          console.log('[완료] 응답에 [DONE] 포함 — 자동응답 중단')
          return
        }

        // Conversation Judge: 3턴마다 대화 계속 여부 판단
        if (turnCount % JUDGE_EVERY === 0) {
          console.log(`[Judge] ${turnCount}턴 도달 — 대화 계속 여부 판단 중...`)
          const shouldContinue = await judgeConversation(conversationHistory, roomGoal, respCmd)
          if (!shouldContinue) {
            loopStopped = true
            consecutiveCount = 0
            console.log('[Judge] 대화 종료 판단 — [DONE] 발송')
            await rc.send(roomId, '[DONE] 대화 목표 달성. 종료합니다.')
          } else {
            console.log('[Judge] 대화 계속 판단')
          }
        }
      } else {
        console.warn('[응답 실패] 이번 턴 스킵')
      }
    }
  })

  await rc.connect(roomId)
}

module.exports = { run }
