'use strict'
/**
 * src/client.js — REST API 클라이언트
 *
 * X-API-Key 인증, JSON 요청/응답.
 */

const https = require('https')
const http  = require('http')

class ApiClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.serverUrl  예: 'https://api.rosud.com/bot-api'
   */
  constructor({ apiKey, serverUrl }) {
    this.apiKey    = apiKey
    this.serverUrl = serverUrl.replace(/\/$/, '')
  }

  /**
   * HTTP 요청 실행.
   * @param {string} method   'GET' | 'POST' | ...
   * @param {string} pathname  예: '/api/rooms/xxx/messages?limit=200'
   * @param {object|null} body JSON body (POST 등)
   * @returns {Promise<object>}
   */
  request(method, pathname, body = null) {
    return new Promise((resolve, reject) => {
      const url    = new URL(this.serverUrl + pathname)
      const isHttps = url.protocol === 'https:'
      const lib    = isHttps ? https : http
      const bodyStr = body ? JSON.stringify(body) : null

      const opts = {
        hostname : url.hostname,
        port     : url.port || (isHttps ? 443 : 80),
        path     : url.pathname + url.search,
        method,
        headers  : {
          'X-API-Key'    : this.apiKey,
          'Content-Type' : 'application/json',
        },
      }
      if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr)

      const req = lib.request(opts, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
      })

      req.on('error', reject)
      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }

  /** 방 목록 조회 */
  getRooms() {
    return this.request('GET', '/api/rooms')
  }

  /**
   * 방 생성
   * @param {{ name: string, roomType?: string, maxTurns?: number, memberIds?: string[] }} opts
   */
  createRoom(opts) {
    return this.request('POST', '/api/rooms', opts)
  }

  /**
   * 단일 방 조회 (goal 필드 포함)
   * @param {string} roomId
   */
  getRoom(roomId) {
    return this.request('GET', `/api/rooms/${roomId}`)
  }

  /**
   * 메시지 목록 조회 (limit=200, after 파라미터 금지)
   * @param {string} roomId
   * @param {number} [limit=200]
   */
  getMessages(roomId, limit = 200) {
    return this.request('GET', `/api/rooms/${roomId}/messages?limit=${limit}`)
  }

  /**
   * 방 멤버 목록 조회 (stub — 서버 API 별도 작업 중)
   * @param {string} _roomId
   * @returns {Promise<string[]>}
   * TODO: 서버 API 구현 후 실제 엔드포인트로 교체 예정
   */
  // eslint-disable-next-line no-unused-vars
  /**
   * 방 멤버 목록 조회
   * @param {string} roomId
   * @returns {Promise<{members: string[]}>}
   */
  getRoomMembers(roomId) {
    return this.request('GET', `/api/rooms/${roomId}/members`)
  }
}

module.exports = { ApiClient }
