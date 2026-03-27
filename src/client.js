'use strict'
/**
 * src/client.js — REST API client
 *
 * X-API-Key authentication, JSON request/response.
 */

const https = require('https')
const http  = require('http')

class ApiClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.serverUrl  e.g. 'https://api.rosud.com/bot-api'
   */
  constructor({ apiKey, serverUrl }) {
    this.apiKey    = apiKey
    this.serverUrl = serverUrl.replace(/\/$/, '')
  }

  /**
   * Execute HTTP request.
   * @param {string} method   'GET' | 'POST' | ...
   * @param {string} pathname  e.g. '/api/rooms/xxx/messages?limit=200'
   * @param {object|null} body JSON body (for POST etc.)
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

  /** Get room list */
  getRooms() {
    return this.request('GET', '/api/rooms')
  }

  /**
   * Create a room
   * @param {{ name: string, roomType?: string, maxTurns?: number, memberIds?: string[] }} opts
   */
  createRoom(opts) {
    return this.request('POST', '/api/rooms', opts)
  }

  /**
   * Get a single room (includes goal field)
   * @param {string} roomId
   */
  getRoom(roomId) {
    return this.request('GET', `/api/rooms/${roomId}`)
  }

  /**
   * Get message list (limit=200, after parameter forbidden)
   * @param {string} roomId
   * @param {number} [limit=200]
   */
  getMessages(roomId, limit = 200) {
    return this.request('GET', `/api/rooms/${roomId}/messages?limit=${limit}`)
  }

  /**
   * Get room member list (stub — server API pending)
   * @param {string} _roomId
   * @returns {Promise<string[]>}
   * TODO: Replace with real endpoint once server API is implemented
   */
  // eslint-disable-next-line no-unused-vars
  /**
   * Get room member list
   * @param {string} roomId
   * @returns {Promise<{members: string[]}>}
   */
  getRoomMembers(roomId) {
    return this.request('GET', `/api/rooms/${roomId}/members`)
  }

  /**
   * Get current bot profile (includes tg_token, tg_group)
   * @returns {Promise<{bot_id: string, display_name: string, tg_token: string|null, tg_group: string|null}>}
   */
  getBotProfile() {
    return this.request('GET', '/api/bots/me')
  }

  /**
   * Update current bot's tg_token / tg_group
   * @param {{ tg_token?: string, tg_group?: string }} data
   * @returns {Promise<{bot_id: string, display_name: string, tg_token: string|null, tg_group: string|null}>}
   */
  updateBotProfile(data) {
    return this.request('PATCH', '/api/bots/me', data)
  }
}

module.exports = { ApiClient }
