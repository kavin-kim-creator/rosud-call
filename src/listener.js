'use strict'
/**
 * listener.js — rosud-call listen command runner
 *
 * Long-running WS subscription + auto-response daemon.
 * Configured via environment variables or CLI options.
 */

const { RosudCall } = require('./index')
const { isDuplicate, markSent } = require('./dedup')
const { spawn } = require('child_process')
const https = require('https')
const http  = require('http')

/**
 * Execute an external command asynchronously and return combined stdout+stderr.
 * - Returns null on timeout (kills process)
 * - Returns null on process error
 *
 * @param {string[]} cmdParts  Command array ([cmd, ...args])
 * @param {number}   timeoutMs Timeout in ms, default 180s
 * @returns {Promise<string|null>}
 */
function runCommand(cmdParts, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(cmdParts[0], cmdParts.slice(1))
    let stdout = ''
    let stderr = ''
    let settled = false  // only the first of close/error/timeout is handled

    // Timeout: force-kill process after specified duration
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        console.warn(`[timeout] ${cmdParts[0]} exceeded ${timeoutMs}ms — giving up`)
        resolve(null)
      }
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    // Process failed to start (command not found, etc.)
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        console.error(`[error] process spawn failed: ${err.message}`)
        resolve(null)
      }
    })

    // Normal exit: return stdout+stderr
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
 * Strip ANSI escape codes and noise lines from process output.
 * @param {string} raw  Raw output string
 * @returns {string}    Cleaned output
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
 * Send a prompt to OpenClaw Gateway HTTP API and receive a response.
 * Returns null on connection failure or non-2xx status -> triggers subprocess fallback.
 *
 * @param {string} prompt      Prompt to send
 * @param {string} gatewayUrl  Gateway HTTP URL (e.g. http://127.0.0.1:18789)
 * @param {number} timeoutMs   Timeout in ms
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
          console.warn(`[Gateway HTTP] timeout ${timeoutMs}ms — subprocess fallback`)
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
              console.warn(`[Gateway HTTP] status ${res.statusCode} — subprocess fallback`)
              resolve(null)
            }
          }
        })
      })

      req.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          console.warn(`[Gateway HTTP] connection failed: ${err.message} — subprocess fallback`)
          resolve(null)
        }
      })

      req.write(body)
      req.end()
    } catch (err) {
      console.warn(`[Gateway HTTP] URL parse failed: ${err.message} — subprocess fallback`)
      resolve(null)
    }
  })
}

/**
 * Generate a response via openclaw CLI. (async)
 * If opts.gatewayUrl is set, tries HTTP API first, falls back to subprocess on failure.
 *
 * @param {string}      sender       Sender ID
 * @param {string}      content      Received message content
 * @param {Array}       history      Previous conversation [{sender, content}]
 * @param {string|null} responderCmd CLI command to use (defaults if null)
 * @param {string|null} goal         Room goal (injected into prompt if set)
 * @param {object}      opts         Options { gatewayUrl, timeoutMs }
 * @returns {Promise<string|null>}
 */
async function getOpenclawResponse(sender, content, history, responderCmd, goal, opts = {}) {
  // Include conversation history (recent N messages excluding current)
  let historySection = ''
  if (history && history.length > 1) {
    const prev = history.slice(0, -1).slice(-8)  // last 8 previous messages
    historySection = '\n\n[Previous Conversation]\n' + prev.map(m => `${m.sender}: ${m.content}`).join('\n') + '\n[/Previous Conversation]\n'
  }

  let prompt = `This is a bot-to-bot message conversation. Continue naturally.${historySection}\nFrom: ${sender}\nContent: ${content}\n\nContinue naturally following the conversation history.`
  if (goal) {
    prompt += `\n\nGoal: ${goal}\nDetermine if the goal has been achieved; if so, append [DONE].`
  } else {
    prompt += ` If the conversation is complete, append [DONE] at the end.`
  }

  const timeoutMs = opts.timeoutMs || 180_000

  // Try Gateway HTTP API first
  if (opts.gatewayUrl) {
    const resp = await callGatewayHttp(prompt, opts.gatewayUrl, timeoutMs)
    if (resp !== null) return cleanOutput(String(resp)) || null
    // null -> subprocess fallback
  }

  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  const raw = await runCommand([...cmdParts, prompt], timeoutMs)
  if (raw === null) return null

  return cleanOutput(raw) || null
}

/**
 * Conversation Judge -- decides whether to continue conversation every 3 turns.
 * Asks openclaw for a yes/no decision.
 * If opts.gatewayUrl is set, tries HTTP API first, falls back to subprocess on failure.
 *
 * @param {Array<{sender: string, content: string}>} history  Recent conversation history
 * @param {string|null} goal
 * @param {string|null} responderCmd
 * @param {object}      opts  Options { gatewayUrl, timeoutMs }
 * @returns {Promise<boolean>}  true = continue, false = stop
 */
async function judgeConversation(history, goal, responderCmd, opts = {}) {
  const historyStr = history
    .map(m => `${m.sender}: ${m.content.slice(0, 200)}`)
    .join('\n')

  const prompt = goal
    ? `Analyze the conversation below and determine whether the goal "${goal}" has been achieved.\nIf achieved, answer "no" (no more conversation needed); if not yet, answer "yes" (continue).\nRespond with exactly one word: yes or no.\n\nConversation:\n${historyStr}`
    : `Analyze the conversation below and determine whether it needs to continue.\nIf it should continue, answer "yes"; if it is complete, answer "no".\nRespond with exactly one word: yes or no.\n\nConversation:\n${historyStr}`

  const judgeTimeout = 30_000  // judge fixed at 30s

  // Try Gateway HTTP API first
  if (opts.gatewayUrl) {
    const resp = await callGatewayHttp(prompt, opts.gatewayUrl, judgeTimeout)
    if (resp !== null) {
      const clean = cleanOutput(String(resp)).replace(/\n/g, ' ').toLowerCase()
      return !(/\bno\b/.test(clean))
    }
    // null -> subprocess fallback
  }

  const cmdParts = (responderCmd || 'openclaw agent --agent main --message').split(' ')
  // async execution (30s timeout)
  const raw = await runCommand([...cmdParts, prompt], judgeTimeout)
  if (raw === null) return true  // default to continue on judgment failure

  const clean = cleanOutput(raw).replace(/\n/g, ' ').toLowerCase()

  // Stop if "no" present (goal achieved or conversation unnecessary)
  return !(/\bno\b/.test(clean))
}

/** Send a Telegram message (optional feature) */
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
 * Run the listen daemon.
 * @param {object} opts  Parsed CLI options
 */
async function run(opts) {
  // Auto-load ~/.config/rosud-call/config.json if env vars not set (env vars take priority)
  if (!process.env.BOT_MESSAGING_API_KEY || !process.env.BOT_MESSAGING_BOT_ID) {
    const { resolveCredentials } = require('./auth')
    const creds = resolveCredentials()
    if (creds.source === 'config') {
      if (!process.env.BOT_MESSAGING_API_KEY) {
        process.env.BOT_MESSAGING_API_KEY = creds.apiKey
        console.log('[auth] loaded API key from config.json')
      }
      if (!process.env.BOT_MESSAGING_BOT_ID) {
        process.env.BOT_MESSAGING_BOT_ID = creds.botId
        console.log('[auth] loaded bot ID from config.json')
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
  // responderUrl option is no longer used (Gateway /api/agent endpoint does not exist)
  // Response generation always uses subprocess (openclaw agent)
  const respOpts        = { timeoutMs: responderTimeout }

  const respondTo = new Set(
    opts.respondTo
      ? opts.respondTo.split(',').map(s => s.trim()).filter(Boolean)
      : []
  )

  // Loop prevention: consecutive response counter + stop flag
  const MAX_CONSECUTIVE = opts.maxTurns ? parseInt(opts.maxTurns) : 10
  const MAX_QUEUE_SIZE  = 3  // max pending queue size (drop on overflow)
  const JUDGE_EVERY = 3
  const MAX_HISTORY = 10

  // -- Per-room independent state management --
  // roomId -> { loopStopped, consecutiveCount, turnCount, history, queue, isProcessing }
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

  // -- Concurrency control (per-room independent queue) --
  // openclaw response generation is async (~10-30s), so even if multiple messages
  // arrive simultaneously, response tasks are executed serially one at a time.
  // Tasks are processed immediately if queue is empty, otherwise after the previous task.
  async function processQueue(rid) {
    const state = getOrCreateRoomState(rid)
    if (state.isProcessing || state.queue.length === 0) return
    state.isProcessing = true
    const task = state.queue.shift()
    try {
      await task()
    } finally {
      state.isProcessing = false
      // Process remaining tasks (use setImmediate to unwind call stack)
      setImmediate(() => processQueue(rid))
    }
  }

  if (!apiKey) { console.error('BOT_MESSAGING_API_KEY env var required'); process.exit(1) }
  if (!botId)  { console.error('BOT_MESSAGING_BOT_ID env var required'); process.exit(1) }
  if (!roomId) { console.error('--room option required'); process.exit(1) }

  console.log(`[rosud-call listen] starting`)
  console.log(`  botId        : ${botId}`)
  console.log(`  room         : ${roomId}`)
  console.log(`  respondTo    : ${[...respondTo].join(', ') || '(none -- mirror only)'}`)
  console.log(`  maxTurns     : ${MAX_CONSECUTIVE}`)
  console.log(`  timeout      : ${responderTimeout}ms`)

  const rc = new RosudCall({ apiKey, botId, filterSelf: true })

  // Auto-fetch TG config from server profile if tgToken or tgGroup is not set
  if (!tgToken || !tgGroup) {
    // BUG-4 fix: retry once after 3s on getBotProfile() failure
    const fetchProfile = async () => {
      const profile = await rc.getBotProfile()
      if (profile?.tg_token) {
        tgToken = profile.tg_token
        console.log(`  [TG] loaded tg_token from server profile`)
      }
      if (profile?.tg_group) {
        tgGroup = profile.tg_group
        console.log(`  [TG] loaded tg_group from server profile`)
      }
      if (!profile?.tg_token && !profile?.tg_group) {
        console.log('  [TG] no TG config on server either')
      }
    }

    try {
      await fetchProfile()
    } catch (err) {
      console.warn(`[warning] bot profile fetch failed (${err.message}) -- retrying in 3s`)
      await new Promise(r => setTimeout(r, 3000))
      try {
        await fetchProfile()
      } catch (err2) {
        console.warn(`[warning] bot profile retry also failed (${err2.message})`)
      }
    }

    if (!tgToken) {
      console.log('  [TG] TG mirroring disabled (no token)')
    }
  }

  // Fetch room goal (null if not set)
  let roomGoal = null
  try {
    const roomInfo = await rc.getRoom(roomId)
    roomGoal = roomInfo?.goal || roomInfo?.room?.goal || null
    if (roomGoal) console.log(`  goal      : ${roomGoal}`)
  } catch {
    // Ignore goal fetch failure
  }

  // Auto-discover room members if --respond-to is not specified -> add to respondTo
  if (respondTo.size === 0) {
    try {
      const raw = await rc.getRoomMembers(roomId)
      const list = Array.isArray(raw) ? raw : (raw?.members || raw?.memberIds || [])
      list.filter(id => id && id !== botId).forEach(id => respondTo.add(id))
      if (respondTo.size > 0) {
        console.log(`  [auto-respond] room members found: ${[...respondTo].join(", ")}`)
      } else {
        console.log("  [auto-respond] no respond targets -- mirror mode")
      }
    } catch (err) {
      console.warn(`[warning] room member fetch failed -- falling back to mirror mode (${err.message})`)
    }
  }

  rc.on('connected',    () => console.log('[connected] WS connected'))
  rc.on('reconnecting', s  => console.log(`[reconnecting] in ${s}s...`))
  rc.on('error',        e  => console.error('[error]', e.message))

  rc.on('room_invite', (e) => {
    console.log(`[invite] new room invite: ${e.roomName} (${e.roomId}) from ${e.invitedBy}`)
    // Create fresh state for new room (ensure loopStopped = false)
    const newState = getOrCreateRoomState(e.roomId)
    newState.loopStopped = false
    rc.subscribe(e.roomId)
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `new room invite: ${e.roomName} (${e.roomId})\nfrom: ${e.invitedBy}`)
    }
    // Add invitedBy to respondTo so auto-response works in new room
    if (respondTo.size > 0 && e.invitedBy) {
      respondTo.add(e.invitedBy)
    }
  })

  rc.on('room_closed', (e) => {
    const closedRoomId = e.roomId || roomId
    console.log(`[room_closed] ${e.reason} (${e.turnCount}/${e.maxTurns} turns) -- room: ${closedRoomId.slice(0, 8)}`)
    const state = getOrCreateRoomState(closedRoomId)
    state.loopStopped = true
    if (tgToken && tgGroup) {
      sendTg(tgToken, tgGroup, `bot conversation ended\nroom: ${closedRoomId.slice(0, 8)}\nreason: ${e.reason} (${e.turnCount} turns)`)
    }
    // Removed process.exit(0) -- listener daemon continues after room close
    // Removed rc.disconnect() -- attempt to resubscribe same room after 5s
    console.log(`[listener] room closed -- retrying in 5s...`)
    setTimeout(async () => {
      try {
        await rc.subscribe(closedRoomId)
        state.loopStopped = false
        console.log(`[reconnected] resubscribed to room ${closedRoomId.slice(0, 8)}`)
      } catch (err) {
        console.warn(`[reconnect failed] ${err.message} -- waiting for new invite`)
      }
    }, 5000)
  })

  rc.on('message', async (msg) => {
    const { senderId, content, createdAt } = msg
    const msgRoomId = msg.roomId || roomId
    const state = getOrCreateRoomState(msgRoomId)
    const ts = (createdAt || '').slice(11, 16)

    // BUG-1: Dedup -- key from createdAt + senderId + first 60 chars of content
    // Including createdAt avoids false positives from identical old messages
    const createdAtKey = (createdAt || '').slice(0, 19) || String(Date.now())
    const dedupKey = `${createdAtKey}:${senderId}:${content.slice(0, 60)}`
    if (isDuplicate(dedupKey)) {
      console.log(`[dedup] duplicate message skipped: ${senderId}: ${content.slice(0, 40)}`)
      return
    }
    markSent(dedupKey)

    console.log(`[recv] ${senderId}: ${content.slice(0, 80)}`)

    // Add to conversation history
    state.history.push({ sender: senderId, content })
    if (state.history.length > MAX_HISTORY) state.history.shift()

    // TG mirroring -- skip own messages, only mirror other bots
    if (tgToken && tgGroup && senderId !== botId) {
      sendTg(tgToken, tgGroup, `bot conversation\n${senderId}: ${content.slice(0, 300)}\n(${ts} UTC)`)
    }

    // [ABORT] permanently stops auto-response
    // [DONE] is a "conversation end signal", not a "listener stop signal"
    // -> Messages containing [DONE] are skipped only; loopStopped is not changed
    if (/\[ABORT\]/i.test(content)) {
      if (!state.loopStopped) {
        state.loopStopped = true
        state.consecutiveCount = 0
        console.log('[stopped] ABORT detected -- auto-response permanently disabled')
      }
      return
    }
    // [DONE] -- skip without responding (loopStopped unchanged)
    if (/\[DONE\]/i.test(content)) {
      console.log('[skip] DONE detected -- skipping response for this message (listener continues)')
      return
    }

    // Auto-response
    const SKIP_PATTERNS = /^(HEARTBEAT_OK|completed|ok)\b/i
    if (respondTo.has(senderId) && !state.loopStopped && !SKIP_PATTERNS.test(content.trim())) {
      // Drop if queue is full (prevent overload on delayed processing)
      if (state.queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[queue drop] queue size (${MAX_QUEUE_SIZE}) exceeded -- dropping: ${content.slice(0, 40)}`)
        return
      }

      // Add response task to queue for serial processing
      // (WS continues receiving messages while openclaw generates a response)
      state.queue.push(async () => {
        // Re-check loopStopped at queue execution time (may have changed while waiting)
        if (state.loopStopped) return

        // Stop if consecutive response limit exceeded
        if (state.consecutiveCount >= MAX_CONSECUTIVE) {
          if (!state.loopStopped) {
            state.loopStopped = true
            console.warn(`[loop guard] ${MAX_CONSECUTIVE} consecutive responses exceeded -- stopping`)
            await rc.send(msgRoomId, `[DONE] max responses (${MAX_CONSECUTIVE}) reached. Ending conversation.`)
          }
          return
        }

        console.log(`[generating] ${senderId} -> (${state.consecutiveCount + 1}/${MAX_CONSECUTIVE})`)
        // await async response generation -- WS event loop continues unblocked
        const response = await getOpenclawResponse(senderId, content, state.history, respCmd, roomGoal, respOpts)
        if (response) {
          state.consecutiveCount++
          state.turnCount++
          state.history.push({ sender: botId, content: response })
          if (state.history.length > MAX_HISTORY) state.history.shift()

          await rc.send(msgRoomId, response)
          console.log(`[sent] ${response.slice(0, 80)}`)

          // Stop if our response contains [DONE]
          if (/\[DONE\]/i.test(response)) {
            state.loopStopped = true
            state.consecutiveCount = 0
            console.log('[done] response contains [DONE] -- stopping auto-response')
            return
          }

          // Conversation Judge: check every 3 turns
          if (state.turnCount % JUDGE_EVERY === 0) {
            console.log(`[judge] turn ${state.turnCount} reached -- checking whether to continue...`)
            const shouldContinue = await judgeConversation(state.history, roomGoal, respCmd, respOpts)
            if (!shouldContinue) {
              state.loopStopped = true
              state.consecutiveCount = 0
              console.log('[judge] decided to end -- sending [DONE]')
              await rc.send(msgRoomId, '[DONE] Conversation goal achieved. Ending.')
            } else {
              console.log('[judge] decided to continue')
            }
          }
        } else {
          console.warn('[response failed] skipping this turn')
        }
      })

      processQueue(msgRoomId)  // Start processing queue (no-op if already running)
    }
  })

  await rc.connect(roomId)

  // Keep event loop alive -- setInterval prevents Node.js from auto-exiting
  // process.stdin.resume() is ineffective in nohup/background environments
  setInterval(() => {}, 60_000)
}

module.exports = { run }
