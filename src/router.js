'use strict'
/**
 * src/router.js — Messenger routing rule engine
 *
 * Determines message routing behavior based on 4 context types.
 *
 * context:
 *   'dm'            — 1:1 DM. Process only messages from humanId, forward to messengerChatId
 *   'group'         — Group chat. Forward to messengerChatId on keyword match
 *   'autonomous'    — Fully autonomous bot. Process all messages, no routing
 *   'cross-platform'— Cross-platform bridge. Relay all messages via messengerFn
 *
 * Usage:
 *   const router = new MessageRouter({
 *     context: 'group',
 *     messengerChatId: '-5208187269',
 *     humanId: '8171314672',
 *     messengerFn: async (chatId, text) => { ... },
 *     keywords: ['done', 'error', 'failed'],
 *   })
 *   rc.on('message', (msg) => router.route(msg))
 */

class MessageRouter {
  /**
   * @param {object} options
   * @param {'dm'|'group'|'autonomous'|'cross-platform'} options.context
   * @param {string}   [options.messengerChatId]  Target chat ID for forwarding
   * @param {string}   [options.humanId]          DM mode: allowed sender ID
   * @param {Function} [options.messengerFn]      (chatId, text) => Promise<void>
   * @param {string[]} [options.keywords]         group mode: forwarding trigger keywords
   * @param {Function} [options.onMessage]        Handler after routing (msg) => void
   */
  constructor(options = {}) {
    const {
      context        = 'autonomous',
      messengerChatId,
      humanId,
      messengerFn,
      keywords       = [],
      onMessage,
    } = options

    this.context         = context
    this.messengerChatId = messengerChatId
    this.humanId         = humanId
    this.messengerFn     = messengerFn
    this.keywords        = keywords.map((k) => k.toLowerCase())
    this.onMessage       = onMessage

    if (context !== 'autonomous' && !messengerFn && context !== 'group') {
      // group only checks keywords; onMessage can be called without messengerFn
    }
  }

  /**
   * Route a message according to context rules.
   * @param {{ id, roomId, senderId, content, createdAt }} msg
   * @returns {Promise<void>}
   */
  async route(msg) {
    switch (this.context) {
      case 'dm':
        return this._routeDm(msg)
      case 'group':
        return this._routeGroup(msg)
      case 'cross-platform':
        return this._routeCrossPlatform(msg)
      case 'autonomous':
      default:
        return this._routeAutonomous(msg)
    }
  }

  // ── context handlers ─────────────────────────────────

  /** DM: only messages from humanId → messengerFn or onMessage */
  async _routeDm(msg) {
    if (this.humanId && msg.senderId !== this.humanId) return
    await this._forward(msg)
  }

  /** Group: forward on keyword match → messengerFn or onMessage */
  async _routeGroup(msg) {
    if (this.keywords.length > 0) {
      const lower = msg.content.toLowerCase()
      const matched = this.keywords.some((k) => lower.includes(k))
      if (!matched) return
    }
    await this._forward(msg)
  }

  /** Cross-platform: all messages → messengerFn */
  async _routeCrossPlatform(msg) {
    await this._forward(msg)
  }

  /** Autonomous: all messages → onMessage only (no external messenger) */
  async _routeAutonomous(msg) {
    if (this.onMessage) this.onMessage(msg)
  }

  /** Call messengerFn + onMessage */
  async _forward(msg) {
    if (this.messengerFn && this.messengerChatId) {
      try {
        await this.messengerFn(this.messengerChatId, msg.content)
      } catch (e) {
        // Forwarding failure does not block onMessage
      }
    }
    if (this.onMessage) this.onMessage(msg)
  }
}

module.exports = { MessageRouter }
