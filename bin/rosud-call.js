#!/usr/bin/env node
'use strict'
/**
 * rosud-call CLI
 * 
 * Usage:
 *   npx rosud-call listen [--room <room-id>] [options]
 * 
 * Environment variables:
 *   BOT_MESSAGING_API_KEY  (required)
 *   BOT_MESSAGING_BOT_ID   (required)
 * 
 * options:
 *   --room        Room UUID (optional — omit to start in invite-wait mode)
 *   --respond-to  Comma-separated bot-ids to auto-respond to (default: none)
 *   --responder   Response generator (default: openclaw)
 *   --tg-token    TG token (for mirroring, optional)
 *   --tg-group    TG group ID (optional)
 */

const args = process.argv.slice(2)
const cmd  = args[0]

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
rosud-call CLI v${require('../package.json').version}

Commands:
  listen    rosud-call constant room subscribe + auto response daemon
  send      send message once to room then exit
  login     save API key + bot ID (can use without env vars after)
  whoami    check saved credentials
  logout    delete saved credentials

Usage:
  npx rosud-call listen --room <room-id> [--respond-to <bot-id>]
  npx rosud-call send --room <room-id> --message <text>
  npx rosud-call login
  npx rosud-call whoami
  npx rosud-call logout

Environment variables (env vars take priority; falls back to login-saved values):
  BOT_MESSAGING_API_KEY   Bot API key
  BOT_MESSAGING_BOT_ID    bot ID

Options:
  --room <uuid>              room UUID to subscribe
  --message <text>           (send only) message content to send
  --api-key <key>            (send only) API key override (replaces env var)
  --respond-to <ids>         Comma-separated bot-ids to auto-respond to (optional -- auto-discovers room members if omitted)
  --responder <cmd>          Response generation command (default: "openclaw agent --agent main --message")
  --responder-url <url>      OpenClaw Gateway HTTP URL (example: http://127.0.0.1:18789)
                             if specified, HTTP API direct call priority, fallback to subprocess on failure
  --responder-timeout <ms>   Response generation timeout (default: 180000ms)
  --tg-token <token>         Telegram mirroring bot token (optional)
  --tg-group <chat-id>       Telegram group chat-id (optional)
  --tg-cmd <cmd>             CLI command for TG send (e.g. "openclaw message send --channel telegram --target -5208187269 --message")
                             Use this instead of --tg-token when Telegram token is not available
  --self-mirror              Also mirror own outgoing responses to TG (default: false)
  --skip-mirror-senders <ids> Comma-separated bot-ids that self-mirror (skip incoming mirror for them to avoid duplicates)

Example:
  npx rosud-call login
  npx rosud-call listen --room <room-uuid>
  npx rosud-call send --room <room-uuid> --message "hello"

  # or specify env vars directly (existing method, backward compatible)
  BOT_MESSAGING_API_KEY=xxx BOT_MESSAGING_BOT_ID=my-bot \\
    npx rosud-call listen \\
    --room <room-uuid>
`)
  process.exit(0)
}

if (cmd === 'login' || cmd === 'init') {
  // Interactive prompt for API key + bot ID, test connection, then save
  const { runLogin } = require('../src/auth')
  runLogin().catch((err) => {
    console.error('[error]', err.message || err)
    process.exit(1)
  })

} else if (cmd === 'whoami') {
  // Print saved credentials (API key masked)
  const { runWhoami } = require('../src/auth')
  runWhoami()

} else if (cmd === 'logout') {
  // delete credentials file
  const { runLogout } = require('../src/auth')
  runLogout()

} else if (cmd === 'send') {
  // BUG-3: one-time message send command
  const opts = parseArgs(args.slice(1))
  const roomId  = opts.room
  const message = opts.message
  const apiKey  = opts.apiKey || process.env.BOT_MESSAGING_API_KEY

  if (!roomId)  { console.error('--room option required'); process.exit(1) }
  if (!message) { console.error('--message option required'); process.exit(1) }

  ;(async () => {
    // Auto-load credentials (env vars take priority, falls back to config.json)
    let resolvedApiKey = apiKey
    let botId = process.env.BOT_MESSAGING_BOT_ID
    if (!resolvedApiKey || !botId) {
      const { resolveCredentials } = require('../src/auth')
      const creds = resolveCredentials()
      if (creds.source === 'config') {
        if (!resolvedApiKey) resolvedApiKey = creds.apiKey
        if (!botId)          botId = creds.botId
      }
    }

    if (!resolvedApiKey) { console.error('BOT_MESSAGING_API_KEY env or --api-key required'); process.exit(1) }
    if (!botId)          { console.error('BOT_MESSAGING_BOT_ID environment variable required'); process.exit(1) }

    const { WsClient } = require('../src/ws-client')
    const { RosudCall } = require('../src/index')

    const rc = new RosudCall({ apiKey: resolvedApiKey, botId, filterSelf: false })
    try {
      await rc.connect(roomId)
      await rc.send(roomId, message)
      console.log(`[send] sent: ${message.slice(0, 80)}`)
    } catch (err) {
      console.error('[send error]', err.message || err)
      process.exit(1)
    } finally {
      await rc.disconnect()
    }
    process.exit(0)
  })().catch((err) => {
    console.error('[error]', err.message || err)
    process.exit(1)
  })

} else if (cmd === 'listen') {
  // if --no-daemon flag, run directly without supervisor (for internal child process)
  if (args.includes('--no-daemon')) {
    process.stdin.resume()
    require('../src/listener').run(parseArgs(args.slice(1).filter(a => a !== '--no-daemon')))
      .catch((err) => {
        console.error('[listener error]', err.message || err)
        process.exit(1)
      })
  } else {
    // Supervisor mode -- spawn self as child process and restart on exit
    runSupervisor(args.slice(1))
  }
} else {
  console.error(`unknown command: ${cmd}`)
  console.error(`available commands: listen, send, login, whoami, logout`)
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

  console.log(`[supervisor] starting — auto-restart mode (max ${MAX_RESTARTS} restarts)`)

  // keep event loop to prevent supervisor from ever terminating
  const keepAlive = setInterval(() => {}, 60_000)

  // separate supervisor from OpenClaw exec session with setsid (if possible)
  process.on('SIGHUP', () => {
    console.log('[supervisor] SIGHUP ignored -- continuing')
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
    console.log(`[supervisor] starting listener (restart # ${restartCount})`)

    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      env: process.env,
      stdio: 'inherit',
      detached: false,
    })

    const startTime = Date.now()

    child.on('exit', (code, signal) => {
      if (stopping) return

      const uptime = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[supervisor] listener terminated (code=${code}, signal=${signal}, uptime=${uptime}s)`)

      restartCount++
      if (restartCount > MAX_RESTARTS) {
        console.error(`[supervisor] max restarts (${MAX_RESTARTS} restarts) exceeded — supervisor exit`)
        clearInterval(keepAlive)
        process.exit(1)
      }

      // if died quickly, increase delay (exponential backoff); if lived long, reset
      if (Date.now() - startTime < 10_000) {
        delayMs = Math.min(delayMs * 1.5, MAX_DELAY_MS)
      } else {
        delayMs = BASE_DELAY_MS
        restartCount = 0
      }

      console.log(`[supervisor] ${(delayMs / 1000).toFixed(1)}s...`)
      setTimeout(spawnChild, delayMs)
    })
  }

  spawnChild()
}
