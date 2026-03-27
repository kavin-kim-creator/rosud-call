'use strict'
/**
 * src/ws-client.js — WebSocket client
 *
 * Bug fixes:
 *  #3  zombie process → ping/pong health check (30s) + exponential backoff reconnect
 *  #6  self-message loop → botId auto-filter
 *
 * Features:
 *  - connect(roomId) — WS connection + subscribe ACK wait
 *  - disconnect() — graceful shutdown
 *  - send(roomId, content) — send message
 *  - Exponential backoff reconnect: 1→2→4→8→...→60s
 *  - ping/pong health check: ping every 30s, reconnect on no response
 */

const WebSocket = require('ws')
const EventEmitter = require('events')

const PING_INTERVAL_MS        = 30_000   // 30 seconds
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000   // max 15s to wait for subscribed ACK after reconnect
const MIN_RETRY_SEC            = 1
const MAX_RETRY_SEC            = 60

class WsClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}   options.apiKey
   * @param {string}   options.wsUrl
   * @param {string}   options.botId
   * @param {Set<string>} options.skipSenders
   * @param {boolean}  [options.filterSelf=true]  if true, filter messages sent by botId
   * @param {Function} options.onMessage    (rawMsg) => void
   * @param {Function} options.toMsg        (m) => msg
   */
  constructor({ apiKey, wsUrl, botId, skipSenders, filterSelf = true, onMessage, toMsg }) {
    super()
    this.apiKey      = apiKey
    this.wsUrl       = wsUrl
    this.botId       = botId
    this.skipSenders = skipSenders
    this.filterSelf  = filterSelf
    this.onMessage   = onMessage
    this.toMsg       = toMsg || ((m) => m)

    this._ws         = null
    this._room       = null
    this._stopped    = false
    this._retryDelay = MIN_RETRY_SEC
    this._pingTimer  = null
    this._subscribeAckTimer = null
    this._connectResolve = null
    this._connectReject  = null
  }

  /** WS connect + subscribe (default 10s timeout) */
  async connect(roomId, { timeoutMs = 10_000 } = {}) {
    this._room    = roomId
    this._stopped = false
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve
      this._connectReject  = reject

      // Connection timeout
      const timer = setTimeout(() => {
        if (this._connectReject) {
          this._connectReject(new Error(`WS connect timeout after ${timeoutMs}ms`))
          this._connectResolve = null
          this._connectReject  = null
        }
      }, timeoutMs)

      // Clear timer after resolve/reject
      const origResolve = resolve
      const origReject  = reject
      this._connectResolve = (...a) => { clearTimeout(timer); origResolve(...a) }
      this._connectReject  = (...a) => { clearTimeout(timer); origReject(...a) }

      this._wsConnect().catch((err) => { clearTimeout(timer); origReject(err) })
    })
  }

  /** Disconnect WS */
  async disconnect() {
    this._stopped = true
    this._clearPing()
    this._clearSubscribeAckTimer()
    if (this._ws) {
      this._ws.terminate()
      this._ws = null
    }
  }

  /**
   * Send a message via WS (connection required).
   * @param {string} roomId
   * @param {string} content
   * @returns {Promise<{ ok: boolean }>}
   */
  sendMessage(roomId, content) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WS not connected'))
      }
      const payload = JSON.stringify({ type: 'send_message', room_id: roomId, content })
      this._ws.send(payload, (err) => {
        if (err) return reject(err)
        resolve({ ok: true })
      })
    })
  }

  /** Check if WS is currently open */
  isOpen() {
    return !!(this._ws && this._ws.readyState === WebSocket.OPEN)
  }

  /**
   * Subscribe to an additional room on an already-connected WS.
   * @param {string} roomId
   */
  subscribeRoom(roomId) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    this._ws.send(JSON.stringify({ type: 'subscribe', room_id: roomId }))
  }

  // ── internal ────────────────────────────────────────

  async _wsConnect() {
    if (this._stopped) return

    const ws = new WebSocket(this.wsUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    this._ws = ws

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', room_id: this._room }))
      this._resetPing()

      // Reconnect case (no Promise unlike initial connect()):
      // Force reconnect if no subscribed ACK within 15s to prevent zombie state
      if (!this._connectResolve) {
        this._subscribeAckTimer = setTimeout(() => {
          console.warn('[ws-client] subscribe ACK timeout — forcing reconnect')
          this._subscribeAckTimer = null
          ws.terminate()
        }, SUBSCRIBE_ACK_TIMEOUT_MS)
      }
    })

    // BUG-2: Handle HTTP-level errors (502/503) — catch before close event, force 5s wait then reconnect
    ws.on('unexpected-response', (req, res) => {
      const statusCode = res.statusCode
      console.warn(`[ws-client] unexpected-response: HTTP ${statusCode}`)
      this._clearPing()
      this._clearSubscribeAckTimer()
      res.resume()  // Consume response body (prevent memory leak)
      ws.terminate()

      if (this._connectReject) {
        this._connectReject(new Error(`WS upgrade failed: HTTP ${statusCode}`))
        this._connectResolve = null
        this._connectReject  = null
        return
      }

      if (!this._stopped && (statusCode === 502 || statusCode === 503)) {
        // Prevent overload during server redeployment: wait at least 5s before reconnect
        const MIN_DEPLOY_WAIT_MS = 5_000
        const retryDelaySec = Math.max(this._retryDelay, MIN_DEPLOY_WAIT_MS / 1000)
        this._retryDelay = Math.min(retryDelaySec * 2, MAX_RETRY_SEC)
        console.warn(`[ws-client] 502/503 detected — reconnecting in ${retryDelaySec}s`)
        this.emit('reconnecting', retryDelaySec)
        setTimeout(() => this._wsConnect(), retryDelaySec * 1000)
      } else if (!this._stopped) {
        this._scheduleReconnect()
      }
    })

    ws.on('message', (raw) => {
      this._resetPing()
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'subscribed') {
        this._clearSubscribeAckTimer()
        this._retryDelay = MIN_RETRY_SEC
        if (this._connectResolve) {
          this._connectResolve()
          this._connectResolve = null
          this._connectReject  = null
        }
        this.emit('connected')
        return
      }

      // [security] handle subscribe error — reject connect() Promise
      if (msg.type === 'error') {
        const code = msg.code || 'UNKNOWN'
        const err  = new Error(`WS error [${code}]: ${msg.message || ''}`)
        err.code   = code
        if (this._connectReject && (code === 'NOT_IN_ROOM' || code === 'RATE_LIMIT' || code === 'VALIDATION_ERROR')) {
          this._connectReject(err)
          this._connectResolve = null
          this._connectReject  = null
        }
        this.emit('error', err)
        return
      }

      if (msg.type === 'message_new') {
        const m = msg.message
        if (this.filterSelf && m.sender_id === this.botId) return
        if (this.skipSenders.has(m.sender_id))  return
        this.onMessage(this.toMsg(m))
      }

      if (msg.type === 'room_closed') {
        this.emit('room_closed', {
          roomId:    msg.room_id,
          reason:    msg.reason,
          turnCount: msg.turn_count,
          maxTurns:  msg.max_turns,
        })
        return
      }

      if (msg.type === 'room_invite') {
        this.emit('room_invite', {
          roomId:    msg.room_id,
          roomName:  msg.room_name,
          invitedBy: msg.invited_by,
        })
        return
      }
    })

    ws.on('pong', () => this._resetPing())

    ws.on('close', (code, reason) => {
      this._clearPing()
      this._clearSubscribeAckTimer()
      // Reject connect() Promise if socket closes during connection
      if (this._connectReject) {
        this._connectReject(new Error(`WS closed before subscribe (code: ${code})`))
        this._connectResolve = null
        this._connectReject  = null
      }
      this.emit('disconnected', { code, reason: reason?.toString() })
      if (!this._stopped) this._scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  _scheduleReconnect() {
    if (this._stopped) return
    const delay = this._retryDelay
    this._retryDelay = Math.min(delay * 2, MAX_RETRY_SEC)
    this.emit('reconnecting', delay)
    setTimeout(() => this._wsConnect(), delay * 1000)
  }

  _resetPing() {
    this._clearPing()
    this._pingTimer = setTimeout(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.ping()
      }
    }, PING_INTERVAL_MS)
  }

  _clearPing() {
    if (this._pingTimer) {
      clearTimeout(this._pingTimer)
      this._pingTimer = null
    }
  }

  _clearSubscribeAckTimer() {
    if (this._subscribeAckTimer) {
      clearTimeout(this._subscribeAckTimer)
      this._subscribeAckTimer = null
    }
  }
}

module.exports = { WsClient }
