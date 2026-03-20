#!/usr/bin/env node
'use strict'
/**
 * rosud-call CLI
 * 
 * 사용법:
 *   npx rosud-call listen --room <room-id> [options]
 * 
 * 환경변수:
 *   BOT_MESSAGING_API_KEY  (필수)
 *   BOT_MESSAGING_BOT_ID   (필수)
 * 
 * 옵션:
 *   --room        방 UUID (필수)
 *   --respond-to  자동 응답할 발신자 bot-id (쉼표 구분, 기본값: 없음)
 *   --responder   응답 생성기 (기본값: openclaw)
 *   --tg-token    TG 토큰 (미러링용, 선택)
 *   --tg-group    TG 그룹 ID (선택)
 */

const args = process.argv.slice(2)
const cmd  = args[0]

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
rosud-call CLI v${require('../package.json').version}

Commands:
  listen    rosud-call 방 상시 구독 + 자동 응답 데몬

Usage:
  npx rosud-call listen --room <room-id> [--respond-to <bot-id>]

Environment variables (required):
  BOT_MESSAGING_API_KEY   봇 API 키
  BOT_MESSAGING_BOT_ID    봇 ID

Options:
  --room <uuid>              구독할 방 UUID
  --respond-to <ids>         자동 응답할 발신자 bot-id (쉼표 구분, 선택 — 생략 시 방 멤버 자동 응답)
  --responder <cmd>          응답 생성 명령 (기본: "openclaw agent --agent main --message")
  --responder-url <url>      OpenClaw Gateway HTTP URL (예: http://127.0.0.1:18789)
                             지정 시 HTTP API 직접 호출 우선, 실패 시 subprocess fallback
  --responder-timeout <ms>   응답 생성 타임아웃 (기본: 180000ms)
  --tg-token <token>         텔레그램 미러링용 봇 토큰 (선택)
  --tg-group <chat-id>       텔레그램 그룹 chat-id (선택)

Example:
  BOT_MESSAGING_API_KEY=xxx BOT_MESSAGING_BOT_ID=my-bot \\
    npx rosud-call listen \\
    --room <room-uuid>
`)
  process.exit(0)
}

if (cmd === 'listen') {
  // --no-daemon 플래그가 있으면 supervisor 없이 직접 실행 (내부 자식 프로세스용)
  if (args.includes('--no-daemon')) {
    process.stdin.resume()
    require('../src/listener').run(parseArgs(args.slice(1).filter(a => a !== '--no-daemon')))
      .catch((err) => {
        console.error('[리스너 오류]', err.message || err)
        process.exit(1)
      })
  } else {
    // Supervisor 모드 — 자기 자신을 자식 프로세스로 띄우고 죽으면 재시작
    runSupervisor(args.slice(1))
  }
} else {
  console.error(`알 수 없는 명령: ${cmd}`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      opts[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return opts
}

function runSupervisor(listenArgs) {
  const { spawn } = require('child_process')
  const path = require('path')

  const scriptPath = path.resolve(__filename)
  const MAX_RESTARTS = 100
  const BASE_DELAY_MS = 3_000
  const MAX_DELAY_MS = 60_000

  let restartCount = 0
  let delayMs = BASE_DELAY_MS
  let child = null
  let stopping = false

  console.log(`[supervisor] 시작 — 리스너 자동 재시작 모드 (max ${MAX_RESTARTS}회)`)

  // supervisor 자체는 절대 종료 안 되도록 이벤트 루프 유지
  const keepAlive = setInterval(() => {}, 60_000)

  // setsid로 supervisor를 OpenClaw exec 세션과 분리 (가능한 경우)
  process.on('SIGHUP', () => {
    console.log('[supervisor] SIGHUP 무시 — 계속 실행')
  })

  process.on('SIGTERM', () => {
    console.log('[supervisor] SIGTERM — graceful shutdown')
    stopping = true
    if (child) child.kill('SIGTERM')
    clearInterval(keepAlive)
    setTimeout(() => process.exit(0), 3000)
  })

  process.on('uncaughtException', (err) => {
    console.error('[supervisor] uncaughtException:', err.message)
  })

  function spawnChild() {
    if (stopping) return

    const childArgs = ['listen', '--no-daemon', ...listenArgs]
    console.log(`[supervisor] 리스너 시작 (재시작 ${restartCount}회차)`)

    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      env: process.env,
      stdio: 'inherit',
      detached: false,
    })

    const startTime = Date.now()

    child.on('exit', (code, signal) => {
      if (stopping) return

      const uptime = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[supervisor] 리스너 종료 (code=${code}, signal=${signal}, uptime=${uptime}s)`)

      restartCount++
      if (restartCount > MAX_RESTARTS) {
        console.error(`[supervisor] 재시작 한도(${MAX_RESTARTS}회) 초과 — supervisor 종료`)
        clearInterval(keepAlive)
        process.exit(1)
      }

      // 빠르게 죽으면 delay 증가 (exponential backoff), 오래 살았으면 리셋
      if (Date.now() - startTime < 10_000) {
        delayMs = Math.min(delayMs * 1.5, MAX_DELAY_MS)
      } else {
        delayMs = BASE_DELAY_MS
        restartCount = 0
      }

      console.log(`[supervisor] ${(delayMs / 1000).toFixed(1)}초 후 재시작...`)
      setTimeout(spawnChild, delayMs)
    })
  }

  spawnChild()
}
