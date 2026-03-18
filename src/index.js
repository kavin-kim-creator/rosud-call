'use strict'
/**
 * rosud-call v2 — Bot Messaging SDK
 *
 * 오늘(2026-03-15) 겪은 버그 10종을 내부에서 모두 처리.
 * 사용자는 비즈니스 로직만 작성하면 됨.
 *
 * 버그 대응 내역:
 *  #1  limit=30 → 구 메시지 재전송   → 내부 limit=200 + ID 루프
 *  #2  after 커서 역방향             → after 파라미터 사용 금지
 *  #3  좀비 프로세스                 → ping/pong 헬스체크 + 지수 백오프
 *  #4  LLM 헤더 노출                 → sanitizer 내장
 *  #6  자기 메시지 루프              → botId 자동 필터
 *  #8  중복 프로세스                 → 파일 기반 lock
 *  #9  폴러 자기 메시지 스킵         → poll()도 botId 자동 필터
 *  #10 ws handle() 자동응답          → on('message') 에서 send() 분리
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
   * @param {boolean}  [options.filterSelf=true]  false이면 자기 메시지도 emit
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

    if (!apiKey) throw new Error('rosud-call: apiKey 필수')
    if (!botId)  throw new Error('rosud-call: botId 필수')

    this.apiKey      = apiKey
    this.botId       = botId
    this.wsUrl       = wsUrl
    this.dedupTtlMs  = dedupTtlMs
    this._doSanitize = doSanitize
    this.skipSenders = new Set(skipSenders)
    this.filterSelf  = filterSelf

    // botId를 파일명에 포함시켜 같은 서버의 다른 봇과 충돌 방지
    const safeId = botId.replace(/[^a-zA-Z0-9_-]/g, '_')
    this._dedupFile  = `/tmp/rosud-call-dedup-${safeId}.json`
    this._stateFile  = `/tmp/rosud-call-state-${safeId}.json`
    this._pollingTimer = null

    // REST 클라이언트
    this._api = new ApiClient({ apiKey, serverUrl })

    // WS 클라이언트
    this._ws = new WsClient({
      apiKey,
      wsUrl,
      botId,
      skipSenders : this.skipSenders,
      filterSelf  : this.filterSelf,
      onMessage   : (msg) => this.emit('message', msg),
      toMsg       : (m)   => this._toMsg(m),
    })

    // WS 이벤트를 RosudCall 이벤트로 전파
    this._ws.on('connected',    ()    => this.emit('connected'))
    this._ws.on('disconnected', (e)   => this.emit('disconnected', e))
    this._ws.on('reconnecting', (sec) => this.emit('reconnecting', sec))
    this._ws.on('error',        (e)   => this.emit('error', e))
    this._ws.on('room_closed',  (e)   => this.emit('room_closed', e))

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
  // WS 리스너 모드 (장기 데몬용)
  // ────────────────────────────────────────────────

  /** WS 연결 + 자동 재연결 시작 */
  async connect(roomId) {
    return this._ws.connect(roomId)
  }

  /** WS 연결 종료 */
  async disconnect() {
    this.stopPolling()
    return this._ws.disconnect()
  }

  // ────────────────────────────────────────────────
  // REST 폴링 모드 (단기 실행 스크립트용)
  // ────────────────────────────────────────────────

  /** 1회 REST 폴링 실행 */
  async poll(roomId, options = {}) {
    const opts = { stateFile: this._stateFile, ...options }
    return this._poller.poll(roomId, opts)
  }

  /**
   * 주기적 폴링 시작.
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

  /** 주기적 폴링 중지 */
  stopPolling() {
    if (this._pollingTimer) {
      clearTimeout(this._pollingTimer)
      this._pollingTimer = null
    }
  }

  // ────────────────────────────────────────────────
  // 메시지 발신
  // ────────────────────────────────────────────────

  /**
   * 메시지 발신.
   * - 활성 WS 연결이 있으면 그걸로 발신
   * - 없으면 일회성 WS 연결 사용
   * - 60초 내 동일 content 재발신 방지
   */
  async send(roomId, content) {
    if (isDuplicate(content, this.dedupTtlMs, this._dedupFile)) {
      this.emit('debug', `dedup skip: ${content.slice(0, 40)}`)
      return null
    }

    // 활성 WS 연결 사용
    if (this._ws.isOpen()) {
      await this._ws.sendMessage(roomId, content)
      markSent(content, this.dedupTtlMs, this._dedupFile)
      return { ok: true }
    }

    // 일회성 WS 연결로 발신
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

  /** 방 목록 조회 */
  getRooms() {
    return this._api.getRooms()
  }

  /**
   * 방 생성
   * @param {{ name: string, roomType?: string, maxTurns?: number, memberIds?: string[] }} opts
   */
  createRoom(opts) {
    return this._api.createRoom(opts)
  }

  // ────────────────────────────────────────────────
  // 내부 유틸
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
