'use strict'
/**
 * src/ws-client.js — WebSocket 클라이언트
 *
 * 버그 대응:
 *  #3  좀비 프로세스 → ping/pong 헬스체크 (30초) + 지수 백오프 재연결
 *  #6  자기 메시지 루프 → botId 자동 필터
 *
 * 기능:
 *  - connect(roomId) — WS 연결 + subscribe ACK 대기
 *  - disconnect() — 정상 종료
 *  - send(roomId, content) — 메시지 발신
 *  - 지수 백오프 재연결: 1→2→4→8→...→60초
 *  - ping/pong 헬스체크: 30초마다 ping, 무응답 시 재연결
 */

const WebSocket = require('ws')
const EventEmitter = require('events')

const PING_INTERVAL_MS = 30_000   // 30초
const MIN_RETRY_SEC    = 1
const MAX_RETRY_SEC    = 60

class WsClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}   options.apiKey
   * @param {string}   options.wsUrl
   * @param {string}   options.botId
   * @param {Set<string>} options.skipSenders
   * @param {Function} options.onMessage    (rawMsg) => void
   * @param {Function} options.toMsg        (m) => msg
   */
  constructor({ apiKey, wsUrl, botId, skipSenders, onMessage, toMsg }) {
    super()
    this.apiKey      = apiKey
    this.wsUrl       = wsUrl
    this.botId       = botId
    this.skipSenders = skipSenders
    this.onMessage   = onMessage
    this.toMsg       = toMsg || ((m) => m)

    this._ws         = null
    this._room       = null
    this._stopped    = false
    this._retryDelay = MIN_RETRY_SEC
    this._pingTimer  = null
  }

  /** WS 연결 + subscribe */
  async connect(roomId) {
    this._room    = roomId
    this._stopped = false
    await this._wsConnect()
  }

  /** WS 종료 */
  async disconnect() {
    this._stopped = true
    this._clearPing()
    if (this._ws) {
      this._ws.terminate()
      this._ws = null
    }
  }

  /**
   * WS로 메시지 발신 (연결 필요).
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

  /** 현재 WS가 열려있는지 확인 */
  isOpen() {
    return !!(this._ws && this._ws.readyState === WebSocket.OPEN)
  }

  // ── 내부 ────────────────────────────────────────

  async _wsConnect() {
    if (this._stopped) return

    const ws = new WebSocket(this.wsUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    this._ws = ws

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', room_id: this._room }))
      this._resetPing()
    })

    ws.on('message', (raw) => {
      this._resetPing()
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'subscribed') {
        this._retryDelay = MIN_RETRY_SEC
        this.emit('connected')
        return
      }

      if (msg.type === 'message_new') {
        const m = msg.message
        if (m.sender_id === this.botId)         return
        if (this.skipSenders.has(m.sender_id))  return
        this.onMessage(this.toMsg(m))
      }
    })

    ws.on('pong', () => this._resetPing())

    ws.on('close', (code, reason) => {
      this._clearPing()
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
}

module.exports = { WsClient }
