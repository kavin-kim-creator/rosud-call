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

const PING_INTERVAL_MS        = 30_000   // 30초
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000   // 재연결 후 subscribed ACK 대기 최대 15초
const MIN_RETRY_SEC            = 1
const MAX_RETRY_SEC            = 60

class WsClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}   options.apiKey
   * @param {string}   options.wsUrl
   * @param {string}   options.botId
   * @param {Set<string>} options.skipSenders
   * @param {boolean}  [options.filterSelf=true]  true면 botId 발신 메시지 필터
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

  /** WS 연결 + subscribe (기본 10초 timeout) */
  async connect(roomId, { timeoutMs = 10_000 } = {}) {
    this._room    = roomId
    this._stopped = false
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve
      this._connectReject  = reject

      // 연결 timeout
      const timer = setTimeout(() => {
        if (this._connectReject) {
          this._connectReject(new Error(`WS connect timeout after ${timeoutMs}ms`))
          this._connectResolve = null
          this._connectReject  = null
        }
      }, timeoutMs)

      // resolve/reject 후 timer 정리
      const origResolve = resolve
      const origReject  = reject
      this._connectResolve = (...a) => { clearTimeout(timer); origResolve(...a) }
      this._connectReject  = (...a) => { clearTimeout(timer); origReject(...a) }

      this._wsConnect().catch((err) => { clearTimeout(timer); origReject(err) })
    })
  }

  /** WS 종료 */
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

  /**
   * 이미 연결된 WS에 추가 방 구독 요청.
   * @param {string} roomId
   */
  subscribeRoom(roomId) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    this._ws.send(JSON.stringify({ type: 'subscribe', room_id: roomId }))
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

      // 재연결 케이스(최초 connect()와 달리 Promise 없음):
      // 15초 내 subscribed ACK 미수신 시 좀비 방지를 위해 강제 재연결
      if (!this._connectResolve) {
        this._subscribeAckTimer = setTimeout(() => {
          console.warn('[ws-client] subscribe ACK timeout — forcing reconnect')
          this._subscribeAckTimer = null
          ws.terminate()
        }, SUBSCRIBE_ACK_TIMEOUT_MS)
      }
    })

    // BUG-2: 502/503 등 HTTP 레벨 오류 처리 — close 이벤트보다 먼저 잡아 5초 강제 대기 후 재연결
    ws.on('unexpected-response', (req, res) => {
      const statusCode = res.statusCode
      console.warn(`[ws-client] unexpected-response: HTTP ${statusCode}`)
      this._clearPing()
      this._clearSubscribeAckTimer()
      res.resume()  // 응답 바디 소비 (메모리 누수 방지)
      ws.terminate()

      if (this._connectReject) {
        this._connectReject(new Error(`WS upgrade failed: HTTP ${statusCode}`))
        this._connectResolve = null
        this._connectReject  = null
        return
      }

      if (!this._stopped && (statusCode === 502 || statusCode === 503)) {
        // 서버 재배포 중 과부하 방지: 최소 5초 대기 후 재연결
        const MIN_DEPLOY_WAIT_MS = 5_000
        const retryDelaySec = Math.max(this._retryDelay, MIN_DEPLOY_WAIT_MS / 1000)
        this._retryDelay = Math.min(retryDelaySec * 2, MAX_RETRY_SEC)
        console.warn(`[ws-client] 502/503 감지 — ${retryDelaySec}초 후 재연결`)
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

      // [보안] subscribe error 처리 — connect() Promise reject
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
      // 연결 중 소켓 닫히면 connect() Promise reject
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
