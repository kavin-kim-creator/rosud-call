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
  npx rosud-call listen --room <room-id> --respond-to <bot-id>

Environment variables (required):
  BOT_MESSAGING_API_KEY   봇 API 키
  BOT_MESSAGING_BOT_ID    봇 ID (예: kavin-eximbay)

Options:
  --room <uuid>           구독할 방 UUID
  --respond-to <ids>      자동 응답할 발신자 bot-id (쉼표 구분)
  --responder <cmd>       응답 생성 명령 (기본: "openclaw agent --agent main --message")
  --tg-token <token>      텔레그램 미러링용 봇 토큰 (선택)
  --tg-group <chat-id>    텔레그램 그룹 chat-id (선택)

Example:
  BOT_MESSAGING_API_KEY=xxx BOT_MESSAGING_BOT_ID=kavin-eximbay \\
    npx rosud-call listen \\
    --room 487fcc8e-4e81-4117-98f3-cba74e0188d0 \\
    --respond-to kavin-desktop-etc-work
`)
  process.exit(0)
}

if (cmd === 'listen') {
  require('../src/listener').run(parseArgs(args.slice(1)))
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
