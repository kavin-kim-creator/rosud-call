'use strict'
/**
 * listener.js — rosud-call listen 명령어 실행기
 * 
 * WS 상시 구독 + 자동 응답 데몬.
 * 환경변수 또는 CLI 옵션으로 설정.
 */

const { RosudCall } = require('./index')
const { execSync, spawnSync } = require('child_process')
const https = require('https')

const BOT_LABELS = {
  'kavin-desktop-etc-work':     '🔧 봇A (CTO/개발자)',
  'kavin-desktop-general-work': '📋 봇C (일반업무)',
  'kavin-eximbay':              '📣 봇B (마케팅/업무보조)',
}

/**
 * openclaw CLI로 응답 생성.
 * stdout에서 플러그인 로그([plugins], ANSI 코드 등) 제거.
 */
function getOpenclawResponse(sender, content, responderCmd) {
  const label = BOT_LABELS[sender] || sender
  const fs = require('fs')
  const path = require('path')

  // bot-respond.py (Bedrock 직접 호출) 우선 사용
  const pyScript = path.join(__dirname, '..', 'scripts', 'bot-respond.py')
  const usePython = !responderCmd && fs.existsSync(pyScript)

  let result
  if (usePython) {
    result = spawnSync('python3', [pyScript, label, content], {
      encoding: 'utf8',
      timeout : 30_000,
    })
    if (result.error) return null
    return (result.stdout || '').trim() || null
  }

  const prompt = `봇 메시지 수신. 발신: ${label} / 내용: ${content}\n\n봇A(개발/CTO)로서 간결하게 응답해줘. 대화가 끝났으면 마지막에 [DONE]을 붙여줘.`
  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  result = spawnSync(cmdParts[0], [...cmdParts.slice(1), prompt], {
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
  const apiKey   = process.env.BOT_MESSAGING_API_KEY
  const botId    = process.env.BOT_MESSAGING_BOT_ID
  const roomId   = opts.room
  const tgToken  = opts.tgToken  || process.env.TELEGRAM_BOT_TOKEN || ''
  const tgGroup  = opts.tgGroup  || process.env.TG_GROUP_ID || ''
  const respCmd  = opts.responder || null  // null이면 listener에서 bot-respond.py 자동 사용

  const respondTo = new Set(
    opts.respondTo
      ? opts.respondTo.split(',').map(s => s.trim()).filter(Boolean)
      : []
  )

  if (!apiKey) { console.error('BOT_MESSAGING_API_KEY 환경변수 필요'); process.exit(1) }
  if (!botId)  { console.error('BOT_MESSAGING_BOT_ID 환경변수 필요'); process.exit(1) }
  if (!roomId) { console.error('--room 옵션 필요'); process.exit(1) }

  console.log(`[rosud-call listen] 시작`)
  console.log(`  botId    : ${botId}`)
  console.log(`  room     : ${roomId}`)
  console.log(`  respondTo: ${[...respondTo].join(', ') || '(없음 — 미러링만)'}`)

  const rc = new RosudCall({ apiKey, botId, filterSelf: true })

  rc.on('connected',    () => console.log('[연결] WS 연결 성공'))
  rc.on('reconnecting', s  => console.log(`[재연결] ${s}초 후...`))
  rc.on('error',        e  => console.error('[오류]', e.message))

  rc.on('message', async (msg) => {
    const { senderId, content, createdAt } = msg
    const label = BOT_LABELS[senderId] || senderId
    const ts    = (createdAt || '').slice(11, 16)
    console.log(`[수신] ${label}: ${content.slice(0, 80)}`)

    // TG 미러링
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `💬 봇 대화\n${label}: ${content.slice(0, 300)}\n(${ts} UTC)`)
    }

    // 자동 응답 — 내부 시스템 메시지 스킵
    const SKIP_PATTERNS = /^(HEARTBEAT_OK|completed|ok|done|\[ABORT\]|\[DONE\])/i
    if (respondTo.has(senderId) && !SKIP_PATTERNS.test(content.trim())) {
      console.log(`[응답 생성] ${senderId} 메시지에 응답 중...`)
      const response = getOpenclawResponse(senderId, content, respCmd)
      if (response) {
        await rc.send(roomId, response)
        console.log(`[발신] ${response.slice(0, 80)}`)
      } else {
        console.warn('[응답 실패] 이번 턴 스킵')
      }
    }
  })

  await rc.connect(roomId)
}

module.exports = { run }
