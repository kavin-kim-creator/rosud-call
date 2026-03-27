'use strict'
/**
 * src/poller.js — REST polling logic
 *
 * Bug fixes:
 *  #1  limit=30 → old message re-delivery  → internal limit=200 + ID loop
 *  #2  after cursor direction bug           → after parameter forbidden
 *
 * Behavior:
 *  - Fetch latest messages with fixed limit=200
 *  - Only invoke callback for messages after last_id
 *  - If no last_id, save latest ID and exit (init only)
 *  - If last_id is out of range, update to latest ID without re-delivery
 */

const fs = require('fs')

const LIMIT = 200

class Poller {
  /**
   * @param {object} options
   * @param {import('./client').ApiClient} options.client
   * @param {string}   options.botId
   * @param {Set<string>} options.skipSenders
   * @param {boolean}  [options.filterSelf=true]  if true, filter messages sent by botId
   * @param {Function} options.onMessage  (msg) => void
   * @param {Function} [options.toMsg]    internal message transform function
   */
  constructor({ client, botId, skipSenders, filterSelf = true, onMessage, toMsg }) {
    this.client      = client
    this.botId       = botId
    this.skipSenders = skipSenders
    this.filterSelf  = filterSelf
    this.onMessage   = onMessage
    this.toMsg       = toMsg || ((m) => m)
  }

  /**
   * Run a single poll cycle.
   * @param {string} roomId
   * @param {object} [options]
   * @param {string} [options.stateFile='/tmp/rosud-call-state.json']
   */
  async poll(roomId, options = {}) {
    const stateFile = options.stateFile || '/tmp/rosud-call-state.json'

    const lastId = this._loadState(stateFile, roomId)
    const data   = await this.client.getMessages(roomId, LIMIT)
    const messages = data.messages || []

    if (!messages.length) return

    if (!lastId) {
      // First run: save current latest and exit (prevent re-delivery of old messages)
      this._saveState(stateFile, roomId, messages[messages.length - 1].id)
      return
    }

    // Collect messages after last_id (index 0 = oldest)
    let found   = false
    const newMsgs = []
    for (const m of messages) {
      if (found) newMsgs.push(m)
      if (m.id === lastId) found = true
    }

    if (!found) {
      // last_id out of range → update to latest without re-delivery
      this._saveState(stateFile, roomId, messages[messages.length - 1].id)
      return
    }

    if (!newMsgs.length) return

    this._saveState(stateFile, roomId, newMsgs[newMsgs.length - 1].id)

    for (const m of newMsgs) {
      if (this.filterSelf && m.sender_id === this.botId) continue
      if (this.skipSenders.has(m.sender_id))  continue
      this.onMessage(this.toMsg(m))
    }
  }

  // ── state file ────────────────────────────────────

  _loadState(stateFile, roomId) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8'))[roomId] || '' }
    catch { return '' }
  }

  _saveState(stateFile, roomId, msgId) {
    let data = {}
    try { data = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch {}
    data[roomId] = msgId
    try { fs.writeFileSync(stateFile, JSON.stringify(data)) } catch {}
  }
}

module.exports = { Poller }
