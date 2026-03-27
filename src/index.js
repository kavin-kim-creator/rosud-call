'use strict'
/**
 * rosud-call v2 — Bot Messaging SDK
 *
 * Handles all 10 bugs encountered today (2026-03-15) internally.
 * Users only need to write business logic.
 *
 * Bug fixes:
 *  #1  limit=30 → old message re-delivery  → internal limit=200 + ID loop
 *  #2  after cursor direction bug           → after parameter forbidden
 *  #3  zombie process                       → ping/pong health check + exponential backoff
 *  #4  LLM header exposure                  → sanitizer built-in
 *  #6  self-message loop                    → botId auto-filter
 *  #8  duplicate processes                  → file-based lock
 *  #9  poller self-message skip             → poll() also auto-filters by botId
 *  #10 ws handle() auto-response            → send() separated from on('message')
 */

const EventEmitter = require('events')
const WebSocket    = require('ws')

const { ApiClient }    = require('./client')
const { WsClient }     = require('./ws-client')
const { Poller }       = require('./poller')
const { isDuplicate, markSent } = require('./dedup')
const { sanitize }     = require('./sanitizer')

class RosudCall extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}   options.apiKey
   * @param {string}   options.botId
   * @param {string}   [options.serverUrl='https://api.rosud.com/bot-api']
   * @param {string}   [options.wsUrl='wss://api.rosud.com/bot-ws']
   * @param {number}   [options.dedupTtlMs=60000]
   * @param {boolean}  [options.sanitize=true]
   * @param {string[]} [options.skipSenders=[]]
   * @param {boolean}  [options.filterSelf=true]  if false, also emit own messages
   */
  constructor(options = {}) {
    super()
    const {
      apiKey,
      botId,
      serverUrl   = 'https://api.rosud.com/bot-api',
      wsUrl       = 'wss://api.rosud.com/bot-ws',
      dedupTtlMs  = 60_000,
      sanitize: doSanitize = true,
      skipSenders = [],
      filterSelf  = true,
    } = options

    if (!apiKey) throw new Error('rosud-call: apiKey is required')
    if (!botId)  throw new Error('rosud-call: botId is required')

    this.apiKey      = apiKey
    this.botId       = botId
    this.wsUrl       = wsUrl
    this.dedupTtlMs  = dedupTtlMs
    this._doSanitize = doSanitize
    this.skipSenders = new Set(skipSenders)
    this.filterSelf  = filterSelf

    // Include botId in filename to avoid conflicts with other bots on the same server
    const safeId = botId.replace(/[^a-zA-Z0-9_-]/g, '_')
    this._dedupFile  = `/tmp/rosud-call-dedup-${safeId}.json`
    this._stateFile  = `/tmp/rosud-call-state-${safeId}.json`
    this._pollingTimer = null

    // REST client
    this._api = new ApiClient({ apiKey, serverUrl })

    // WS client
    this._ws = new WsClient({
      apiKey,
      wsUrl,
      botId,
      skipSenders : this.skipSenders,
      filterSelf  : this.filterSelf,
      onMessage   : (msg) => this.emit('message', msg),
      toMsg       : (m)   => this._toMsg(m),
    })

    // Propagate WS events to RosudCall events
    this._ws.on('connected',    ()    => this.emit('connected'))
    this._ws.on('disconnected', (e)   => this.emit('disconnected', e))
    this._ws.on('reconnecting', (sec) => this.emit('reconnecting', sec))
    this._ws.on('error',        (e)   => this.emit('error', e))
    this._ws.on('room_closed',  (e)   => this.emit('room_closed', e))
    this._ws.on('room_invite',  (e)   => this.emit('room_invite', e))

    // Poller
    this._poller = new Poller({
      client      : this._api,
      botId,
      skipSenders : this.skipSenders,
      filterSelf  : this.filterSelf,
      onMessage   : (msg) => this.emit('message', msg),
      toMsg       : (m)   => this._toMsg(m),
    })
  }

  // ────────────────────────────────────────────────
  // WS listener mode (long-running daemon)
  // ────────────────────────────────────────────────

  /** Start WS connection + auto-reconnect */
  async connect(roomId) {
    return this._ws.connect(roomId)
  }

  /** Disconnect WS */
  async disconnect() {
    this.stopPolling()
    return this._ws.disconnect()
  }

  /** Subscribe to an additional room on an already-connected WS */
  subscribe(roomId) {
    this._ws.subscribeRoom(roomId)
  }

  // ────────────────────────────────────────────────
  // REST polling mode (short-lived scripts)
  // ────────────────────────────────────────────────

  /** Run a single REST poll cycle */
  async poll(roomId, options = {}) {
    const opts = { stateFile: this._stateFile, ...options }
    return this._poller.poll(roomId, opts)
  }

  /**
   * Start periodic polling.
   * @param {string} roomId
   * @param {object} [options]
   * @param {number} [options.intervalMs=5000]
   * @param {string} [options.stateFile]
   */
  startPolling(roomId, options = {}) {
    const { intervalMs = 5_000, stateFile = this._stateFile } = options
    if (this._pollingTimer) return

    const tick = async () => {
      try { await this._poller.poll(roomId, { stateFile }) }
      catch (e) { this.emit('error', e) }
      if (this._pollingTimer !== null) {
        this._pollingTimer = setTimeout(tick, intervalMs)
      }
    }

    this._pollingTimer = setTimeout(tick, 0)
  }

  /** Stop periodic polling */
  stopPolling() {
    if (this._pollingTimer) {
      clearTimeout(this._pollingTimer)
      this._pollingTimer = null
    }
  }

  // ────────────────────────────────────────────────
  // Message sending
  // ────────────────────────────────────────────────

  /**
   * Send a message.
   * - Uses active WS connection if available
   * - Falls back to one-time WS connection otherwise
   * - Prevents re-sending the same content within 60s
   */
  async send(roomId, content) {
    if (isDuplicate(content, this.dedupTtlMs, this._dedupFile)) {
      this.emit('debug', `dedup skip: ${content.slice(0, 40)}`)
      return null
    }

    // Use active WS connection
    if (this._ws.isOpen()) {
      await this._ws.sendMessage(roomId, content)
      markSent(content, this.dedupTtlMs, this._dedupFile)
      return { ok: true }
    }

    // Fall back to one-time WS connection
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', room_id: roomId }))
      })
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw)
        if (msg.type === 'subscribed') {
          ws.send(JSON.stringify({ type: 'send_message', room_id: roomId, content }))
        } else if (msg.type === 'message_new' && msg.message?.content === content) {
          markSent(content, this.dedupTtlMs, this._dedupFile)
          ws.close()
          resolve({ ok: true, id: msg.message.id })
        }
      })
      ws.on('error', reject)
      setTimeout(() => { ws.close(); resolve({ ok: true }) }, 5000)
    })
  }

  // ────────────────────────────────────────────────
  // REST API
  // ────────────────────────────────────────────────

  /** Get room list */
  getRooms() {
    return this._api.getRooms()
  }

  /** Get single room (includes goal field) */
  getRoom(roomId) {
    return this._api.getRoom(roomId)
  }

  /**
   * Create a room
   * @param {{ name: string, roomType?: string, maxTurns?: number, memberIds?: string[] }} opts
   */
  createRoom(opts) {
    return this._api.createRoom(opts)
  }

  /** Get room member list (stub — server API pending) */
  getRoomMembers(roomId) {
    return this._api.getRoomMembers(roomId)
  }

  /** Get current bot profile (includes tg_token, tg_group) */
  getBotProfile() {
    return this._api.getBotProfile()
  }

  /**
   * Update current bot's tg_token / tg_group
   * @param {{ tg_token?: string, tg_group?: string }} data
   */
  updateBotProfile(data) {
    return this._api.updateBotProfile(data)
  }

  // ────────────────────────────────────────────────
  // Internal utilities
  // ────────────────────────────────────────────────

  _toMsg(m) {
    const content = this._doSanitize ? sanitize(m.content || '') : (m.content || '')
    return {
      id        : m.id,
      roomId    : m.room_id,
      senderId  : m.sender_id,
      content,
      createdAt : m.created_at,
    }
  }
}

module.exports = { RosudCall }
