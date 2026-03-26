'use strict'
/**
 * listener.js — rosud-call listen 명령어 실행기
 *
 * WS 상시 구독 + 자동 응답 데몬.
 * 환경변수 또는 CLI 옵션으로 설정.
 */

const { RosudCall } = require('./index')
const { isDuplicate, markSent } = require('./dedup')
const { spawn } = require('child_process')
const https = require('https')
const http  = require('http')

/**
 * 외부 명령어를 비동기로 실행하고 stdout+stderr 조합 문자열을 반환한다.
 * - 타임아웃 초과 시 프로세스를 kill하고 null 반환
 * - 프로세스 오류 시 null 반환
 *
 * @param {string[]} cmdParts  실행할 명령어 배열 ([cmd, ...args])
 * @param {number}   timeoutMs 타임아웃 (ms), 기본 60초
 * @returns {Promise<string|null>}
 */
function runCommand(cmdParts, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(cmdParts[0], cmdParts.slice(1))
    let stdout = ''
    let stderr = ''
    let settled = false  // close/error/timeout 중 첫 번째만 처리

    // 타임아웃: 지정 시간 초과 시 프로세스 강제 종료
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        console.warn(`[타임아웃] ${cmdParts[0]} 실행 ${timeoutMs}ms 초과 — 응답 포기`)
        resolve(null)
      }
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    // 프로세스 시작 자체가 실패한 경우 (명령어 없음 등)
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        console.error(`[오류] 프로세스 실행 실패: ${err.message}`)
        resolve(null)
      }
    })

    // 정상 종료: stdout+stderr 반환
    child.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(stdout + '\n' + stderr)
      }
    })
  })
}

/**
 * 프로세스 출력에서 ANSI 이스케이프 코드와 노이즈 라인을 제거한다.
 * @param {string} raw  원본 출력 문자열
 * @returns {string}    정제된 출력
 */
function cleanOutput(raw) {
  return raw
    .split('\n')
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(l => l && !/^\[plugins\]|\[memory|\[gateway|^memory-lancedb|^session-strategy/.test(l))
    .join('\n')
    .trim()
}

/**
 * OpenClaw Gateway HTTP API로 프롬프트 전송 후 응답 수신.
 * 연결 실패 / 비정상 상태코드 시 null 반환 → subprocess fallback 트리거.
 *
 * @param {string} prompt      전송할 프롬프트
 * @param {string} gatewayUrl  Gateway HTTP URL (예: http://127.0.0.1:18789)
 * @param {number} timeoutMs   타임아웃 (ms)
 * @returns {Promise<string|null>}
 */
function callGatewayHttp(prompt, gatewayUrl, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(gatewayUrl)
      const lib = parsedUrl.protocol === 'https:' ? https : http
      const body = JSON.stringify({ prompt, agent: 'main' })
      const options = {
        hostname: parsedUrl.hostname,
        port    : parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path    : (parsedUrl.pathname.replace(/\/$/, '') || '') + '/api/agent',
        method  : 'POST',
        headers : {
          'Content-Type'  : 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }

      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          req.destroy()
          console.warn(`[Gateway HTTP] 타임아웃 ${timeoutMs}ms 초과 — subprocess fallback`)
          resolve(null)
        }
      }, timeoutMs)

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = JSON.parse(data)
                resolve(json.response || json.text || json.content || data)
              } catch {
                resolve(data)
              }
            } else {
              console.warn(`[Gateway HTTP] 상태 코드 ${res.statusCode} — subprocess fallback`)
              resolve(null)
            }
          }
        })
      })

      req.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          console.warn(`[Gateway HTTP] 연결 실패: ${err.message} — subprocess fallback`)
          resolve(null)
        }
      })

      req.write(body)
      req.end()
    } catch (err) {
      console.warn(`[Gateway HTTP] URL 파싱 실패: ${err.message} — subprocess fallback`)
      resolve(null)
    }
  })
}

/**
 * openclaw CLI로 응답 생성. (비동기)
 * opts.gatewayUrl 지정 시 HTTP API 먼저 시도, 실패 시 subprocess fallback.
 *
 * @param {string}      sender       발신자 ID
 * @param {string}      content      수신 메시지 내용
 * @param {Array}       history      이전 대화 내역 [{sender, content}]
 * @param {string|null} responderCmd 사용할 CLI 명령어 (없으면 기본값)
 * @param {string|null} goal         방 goal (있으면 프롬프트에 주입)
 * @param {object}      opts         옵션 { gatewayUrl, timeoutMs }
 * @returns {Promise<string|null>}
 */
async function getOpenclawResponse(sender, content, history, responderCmd, goal, opts = {}) {
  // 이전 대화 내역 포함 (현재 메시지 제외한 최근 N개)
  let historySection = ''
  if (history && history.length > 1) {
    const prev = history.slice(0, -1).slice(-8)  // 최근 8개 이전 메시지
    historySection = '\n\n[이전 대화]\n' + prev.map(m => `${m.sender}: ${m.content}`).join('\n') + '\n[/이전 대화]\n'
  }

  let prompt = `봇 간 메시지 대화야. 자연스럽게 이어가줘.${historySection}\n발신: ${sender}\n내용: ${content}\n\n이전 대화 흐름을 이어서 자연스럽게 응답해줘.`
  if (goal) {
    prompt += `\n\n목표: ${goal}\n목표 달성 여부를 판단하고 달성됐으면 반드시 [DONE]을 붙여라.`
  } else {
    prompt += ` 대화가 끝났으면 마지막에 [DONE]을 붙여줘.`
  }

  const timeoutMs = opts.timeoutMs || 180_000

  // Gateway HTTP API 우선 시도
  if (opts.gatewayUrl) {
    const resp = await callGatewayHttp(prompt, opts.gatewayUrl, timeoutMs)
    if (resp !== null) return cleanOutput(String(resp)) || null
    // null이면 subprocess fallback
  }

  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  const raw = await runCommand([...cmdParts, prompt], timeoutMs)
  if (raw === null) return null

  return cleanOutput(raw) || null
}

/**
 * Conversation Judge — 3턴마다 대화 계속 여부 판단.
 * openclaw에게 yes/no 판단 요청.
 * opts.gatewayUrl 지정 시 HTTP API 우선 시도, 실패 시 subprocess fallback.
 *
 * @param {Array<{sender: string, content: string}>} history  최근 대화 내역
 * @param {string|null} goal
 * @param {string|null} responderCmd
 * @param {object}      opts  옵션 { gatewayUrl, timeoutMs }
 * @returns {Promise<boolean>}  true = 계속, false = 종료
 */
async function judgeConversation(history, goal, responderCmd, opts = {}) {
  const historyStr = history
    .map(m => `${m.sender}: ${m.content.slice(0, 200)}`)
    .join('\n')

  const prompt = goal
    ? `아래 대화를 분석해서 "${goal}" 목표가 달성됐는지 판단해.\n달성됐으면 "no" (대화 불필요), 아직이면 "yes" (대화 계속 필요).\n반드시 yes 또는 no 한 단어만 답해라.\n\n대화:\n${historyStr}`
    : `아래 대화를 분석해서 계속 진행이 필요한지 판단해.\n계속 필요하면 "yes", 대화가 끝났으면 "no".\n반드시 yes 또는 no 한 단어만 답해라.\n\n대화:\n${historyStr}`

  const judgeTimeout = 30_000  // judge는 30초 고정

  // Gateway HTTP API 우선 시도
  if (opts.gatewayUrl) {
    const resp = await callGatewayHttp(prompt, opts.gatewayUrl, judgeTimeout)
    if (resp !== null) {
      const clean = cleanOutput(String(resp)).replace(/\n/g, ' ').toLowerCase()
      return !(/\bno\b/.test(clean))
    }
    // null이면 subprocess fallback
  }

  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  // 비동기 실행 (타임아웃 30초)
  const raw = await runCommand([...cmdParts, prompt], judgeTimeout)
  if (raw === null) return true  // 판단 실패 시 기본 계속 진행

  const clean = cleanOutput(raw).replace(/\n/g, ' ').toLowerCase()

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
  // 환경변수 없으면 ~/.config/rosud-call/config.json 자동 로드 (환경변수 우선)
  if (!process.env.BOT_MESSAGING_API_KEY || !process.env.BOT_MESSAGING_BOT_ID) {
    const { resolveCredentials } = require('./auth')
    const creds = resolveCredentials()
    if (creds.source === 'config') {
      if (!process.env.BOT_MESSAGING_API_KEY) {
        process.env.BOT_MESSAGING_API_KEY = creds.apiKey
        console.log('[인증] config.json에서 API 키 로드')
      }
      if (!process.env.BOT_MESSAGING_BOT_ID) {
        process.env.BOT_MESSAGING_BOT_ID = creds.botId
        console.log('[인증] config.json에서 봇 ID 로드')
      }
    }
  }

  const apiKey  = process.env.BOT_MESSAGING_API_KEY
  const botId   = process.env.BOT_MESSAGING_BOT_ID
  const roomId  = opts.room
  let tgToken = opts.tgToken  || process.env.TELEGRAM_BOT_TOKEN || ''
  let tgGroup = opts.tgGroup  || process.env.TG_GROUP_ID || ''
  const respCmd         = opts.responder || null
  const responderTimeout = opts.responderTimeout ? parseInt(opts.responderTimeout) : 180_000
  // responderUrl 옵션은 더 이상 사용하지 않음 (Gateway /api/agent 미존재)
  // 응답 생성은 항상 subprocess(openclaw agent) 방식 사용
  const respOpts        = { timeoutMs: responderTimeout }

  const respondTo = new Set(
    opts.respondTo
      ? opts.respondTo.split(',').map(s => s.trim()).filter(Boolean)
      : []
  )

  // 루프 방지: 연속 응답 카운터 + 중단 플래그
  const MAX_CONSECUTIVE = opts.maxTurns ? parseInt(opts.maxTurns) : 10
  const MAX_QUEUE_SIZE  = 3  // 대기 큐 최대 크기 (초과 시 드랍)
  const JUDGE_EVERY = 3
  const MAX_HISTORY = 10

  // ── 방(room)당 독립 상태 관리 ────────────────────────────────
  // roomId → { loopStopped, consecutiveCount, turnCount, history, queue, isProcessing }
  const roomStates = new Map()

  function getOrCreateRoomState(rid) {
    if (!roomStates.has(rid)) {
      roomStates.set(rid, {
        loopStopped     : false,
        consecutiveCount: 0,
        turnCount       : 0,
        history         : [],
        queue           : [],
        isProcessing    : false,
      })
    }
    return roomStates.get(rid)
  }

  // ── 동시성 제어 (방별 독립 큐) ──────────────────────────────
  // openclaw 응답 생성이 비동기(~10-30초)이므로 동시에 여러 메시지가
  // 도착해도 응답 생성 작업은 순서대로 한 번에 하나씩만 실행한다.
  // 큐에 쌓인 작업이 없으면 즉시 처리, 있으면 이전 작업 완료 후 실행.
  async function processQueue(rid) {
    const state = getOrCreateRoomState(rid)
    if (state.isProcessing || state.queue.length === 0) return
    state.isProcessing = true
    const task = state.queue.shift()
    try {
      await task()
    } finally {
      state.isProcessing = false
      // 큐에 남은 작업 연속 처리 (setImmediate로 콜스택 해소)
      setImmediate(() => processQueue(rid))
    }
  }

  if (!apiKey) { console.error('BOT_MESSAGING_API_KEY 환경변수 필요'); process.exit(1) }
  if (!botId)  { console.error('BOT_MESSAGING_BOT_ID 환경변수 필요'); process.exit(1) }
  if (!roomId) { console.error('--room 옵션 필요'); process.exit(1) }

  console.log(`[rosud-call listen] 시작`)
  console.log(`  botId        : ${botId}`)
  console.log(`  room         : ${roomId}`)
  console.log(`  respondTo    : ${[...respondTo].join(', ') || '(없음 — 미러링만)'}`)
  console.log(`  maxTurns     : ${MAX_CONSECUTIVE}`)
  console.log(`  timeout      : ${responderTimeout}ms`)
  if (responderUrl) console.log(`  responderUrl : ${responderUrl}`)

  const rc = new RosudCall({ apiKey, botId, filterSelf: true })

  // tgToken/tgGroup 하나라도 미설정 시 서버 프로필에서 자동 조회
  if (!tgToken || !tgGroup) {
    // BUG-4 수정: getBotProfile() 실패 시 3초 후 1회 재시도
    const fetchProfile = async () => {
      const profile = await rc.getBotProfile()
      if (profile?.tg_token) {
        tgToken = profile.tg_token
        console.log(`  [TG] 서버 프로필에서 tg_token 로드 완료`)
      }
      if (profile?.tg_group) {
        tgGroup = profile.tg_group
        console.log(`  [TG] 서버 프로필에서 tg_group 로드 완료`)
      }
      if (!profile?.tg_token && !profile?.tg_group) {
        console.log('  [TG] 서버에도 TG 설정 없음')
      }
    }

    try {
      await fetchProfile()
    } catch (err) {
      console.warn(`[경고] 봇 프로필 조회 실패 (${err.message}) — 3초 후 재시도`)
      await new Promise(r => setTimeout(r, 3000))
      try {
        await fetchProfile()
      } catch (err2) {
        console.warn(`[경고] 봇 프로필 재시도도 실패 (${err2.message})`)
      }
    }

    if (!tgToken) {
      console.log('  [TG] TG 미러링 비활성 (토큰 없음)')
    }
  }

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
      const list = Array.isArray(raw) ? raw : (raw?.members || raw?.memberIds || [])
      list.filter(id => id && id !== botId).forEach(id => respondTo.add(id))
      if (respondTo.size > 0) {
        console.log(`  [자동 응답] 방 멤버 조회 성공: ${[...respondTo].join(", ")}`)
      } else {
        console.log("  [자동 응답] 응답 대상 없음 — 미러링 모드로 동작")
      }
    } catch (err) {
      console.warn(`[경고] 방 멤버 조회 실패 — 미러링 모드로 폴백 (${err.message})`)
    }
  }

  rc.on('connected',    () => console.log('[연결] WS 연결 성공'))
  rc.on('reconnecting', s  => console.log(`[재연결] ${s}초 후...`))
  rc.on('error',        e  => console.error('[오류]', e.message))

  rc.on('room_invite', (e) => {
    console.log(`[초대] 새 방 초대: ${e.roomName} (${e.roomId}) from ${e.invitedBy}`)
    // 새 방 fresh state 생성 (loopStopped = false 보장)
    const newState = getOrCreateRoomState(e.roomId)
    newState.loopStopped = false
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
    const closedRoomId = e.roomId || roomId
    console.log(`[방 종료] ${e.reason} (${e.turnCount}/${e.maxTurns}턴) — 방: ${closedRoomId.slice(0, 8)}`)
    const state = getOrCreateRoomState(closedRoomId)
    state.loopStopped = true
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `🔒 봇 대화 종료\n방: ${closedRoomId.slice(0, 8)}\n이유: ${e.reason} (${e.turnCount}턴)`)
    }
    // process.exit(0) 제거 — 리스너 데몬은 방 종료 후에도 계속 실행 유지
    // rc.disconnect() 제거 — 5초 후 동일 방 재구독 시도
    console.log(`[리스너] 방 종료 — 5초 후 재연결 시도...`)
    setTimeout(async () => {
      try {
        await rc.subscribe(closedRoomId)
        state.loopStopped = false
        console.log(`[재연결] 방 ${closedRoomId.slice(0, 8)} 재구독 성공`)
      } catch (err) {
        console.warn(`[재연결 실패] ${err.message} — 새 초대를 기다립니다`)
      }
    }, 5000)
  })

  rc.on('message', async (msg) => {
    const { senderId, content, createdAt } = msg
    const msgRoomId = msg.roomId || roomId
    const state = getOrCreateRoomState(msgRoomId)
    const ts = (createdAt || '').slice(11, 16)

    // BUG-1: 중복 메시지 방지 — createdAt + senderId + content 앞 60자로 키 생성
    // createdAt 포함으로 과거 동일 내용 메시지와 구분 (오탐 방지)
    const createdAtKey = (createdAt || '').slice(0, 19) || String(Date.now())
    const dedupKey = `${createdAtKey}:${senderId}:${content.slice(0, 60)}`
    if (isDuplicate(dedupKey)) {
      console.log(`[dedup] 중복 메시지 스킵: ${senderId}: ${content.slice(0, 40)}`)
      return
    }
    markSent(dedupKey)

    console.log(`[수신] ${senderId}: ${content.slice(0, 80)}`)

    // 대화 이력 추가
    state.history.push({ sender: senderId, content })
    if (state.history.length > MAX_HISTORY) state.history.shift()

    // TG 미러링 — 본인이 보낸 메시지는 제외, 타 봇 메시지만 미러링
    if (tgToken && tgGroup && senderId !== botId) {
      sendTg(tgToken, tgGroup, `💬 봇 대화\n${senderId}: ${content.slice(0, 300)}\n(${ts} UTC)`)
    }

    // [ABORT] 수신 시만 자동응답 영구 중단
    // [DONE]은 "대화 종료 신호"이지 "리스너 중단 신호"가 아님
    // → [DONE] 포함 메시지는 스킵만 하고 loopStopped 건드리지 않음
    if (/\[ABORT\]/i.test(content)) {
      if (!state.loopStopped) {
        state.loopStopped = true
        state.consecutiveCount = 0
        console.log('[중단] ABORT 감지 — 자동응답 영구 중단')
      }
      return
    }
    // [DONE]은 응답하지 않고 스킵 (loopStopped 변경 없음)
    if (/\[DONE\]/i.test(content)) {
      console.log('[스킵] DONE 감지 — 이번 메시지 응답 생략 (리스너 유지)')
      return
    }

    // 자동 응답
    const SKIP_PATTERNS = /^(HEARTBEAT_OK|completed|ok)\b/i
    if (respondTo.has(senderId) && !state.loopStopped && !SKIP_PATTERNS.test(content.trim())) {
      // 큐 크기 초과 시 드랍 (처리 지연 시 과부하 방지)
      if (state.queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[큐 드랍] 큐 크기(${MAX_QUEUE_SIZE}) 초과 — 메시지 드랍: ${content.slice(0, 40)}`)
        return
      }

      // 응답 생성 작업을 큐에 추가하여 순서대로 직렬 처리
      // (openclaw 응답 생성 중 새 메시지가 와도 WS 수신은 계속됨)
      state.queue.push(async () => {
        // 큐 실행 시점에 다시 loopStopped 체크 (큐 대기 중 상태 변경 가능)
        if (state.loopStopped) return

        // 연속 응답 횟수 초과 시 자동 중단
        if (state.consecutiveCount >= MAX_CONSECUTIVE) {
          if (!state.loopStopped) {
            state.loopStopped = true
            console.warn(`[루프 방지] ${MAX_CONSECUTIVE}회 연속 응답 초과 — 자동응답 중단`)
            await rc.send(msgRoomId, `[DONE] 최대 응답 횟수(${MAX_CONSECUTIVE}회) 초과. 대화 종료.`)
          }
          return
        }

        console.log(`[응답 생성] ${senderId} → (${state.consecutiveCount + 1}/${MAX_CONSECUTIVE})`)
        // await로 비동기 응답 생성 — WS 이벤트 루프는 블로킹 없이 유지됨
        const response = await getOpenclawResponse(senderId, content, state.history, respCmd, roomGoal, respOpts)
        if (response) {
          state.consecutiveCount++
          state.turnCount++
          state.history.push({ sender: botId, content: response })
          if (state.history.length > MAX_HISTORY) state.history.shift()

          await rc.send(msgRoomId, response)
          console.log(`[발신] ${response.slice(0, 80)}`)

          // 내가 보낸 응답에 [DONE] 포함 시 중단
          if (/\[DONE\]/i.test(response)) {
            state.loopStopped = true
            state.consecutiveCount = 0
            console.log('[완료] 응답에 [DONE] 포함 — 자동응답 중단')
            return
          }

          // Conversation Judge: 3턴마다 대화 계속 여부 판단
          if (state.turnCount % JUDGE_EVERY === 0) {
            console.log(`[Judge] ${state.turnCount}턴 도달 — 대화 계속 여부 판단 중...`)
            const shouldContinue = await judgeConversation(state.history, roomGoal, respCmd, respOpts)
            if (!shouldContinue) {
              state.loopStopped = true
              state.consecutiveCount = 0
              console.log('[Judge] 대화 종료 판단 — [DONE] 발송')
              await rc.send(msgRoomId, '[DONE] 대화 목표 달성. 종료합니다.')
            } else {
              console.log('[Judge] 대화 계속 판단')
            }
          }
        } else {
          console.warn('[응답 실패] 이번 턴 스킵')
        }
      })

      processQueue(msgRoomId)  // 큐에 작업 추가 후 처리 시작 (이미 실행 중이면 no-op)
    }
  })

  await rc.connect(roomId)

  // 이벤트 루프 강제 유지 — setInterval로 Node.js가 자동 종료되지 않도록 고정
  // process.stdin.resume()은 stdin이 닫힌 환경(nohup, 백그라운드)에서 효과 없음
  setInterval(() => {}, 60_000)
}

module.exports = { run }
