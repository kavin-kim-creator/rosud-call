'use strict'
/**
 * src/router.js — 메신저 라우팅 규칙 엔진
 *
 * 4가지 context에 따라 메시지 라우팅 동작을 결정.
 *
 * context:
 *   'dm'            — 1:1 DM. humanId의 메시지만 처리, messengerChatId로 포워딩
 *   'group'         — 그룹방. keywords 매칭 시 messengerChatId로 포워딩
 *   'autonomous'    — 완전 자율 봇. 모든 메시지 처리, 라우팅 없음
 *   'cross-platform'— 플랫폼 간 브릿지. messengerFn으로 모든 메시지 중계
 *
 * 사용 예:
 *   const router = new MessageRouter({
 *     context: 'group',
 *     messengerChatId: '-5208187269',
 *     humanId: '8171314672',
 *     messengerFn: async (chatId, text) => { ... },
 *     keywords: ['완료', '에러', 'done', 'error', 'failed'],
 *   })
 *   rc.on('message', (msg) => router.route(msg))
 */

class MessageRouter {
  /**
   * @param {object} options
   * @param {'dm'|'group'|'autonomous'|'cross-platform'} options.context
   * @param {string}   [options.messengerChatId]  포워딩 대상 채팅 ID
   * @param {string}   [options.humanId]          DM 모드: 허용할 발신자 ID
   * @param {Function} [options.messengerFn]      (chatId, text) => Promise<void>
   * @param {string[]} [options.keywords]         group 모드: 포워딩 트리거 키워드
   * @param {Function} [options.onMessage]        라우팅 후 핸들러 (msg) => void
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
      // group은 keywords만 체크, messengerFn 없어도 onMessage 호출 가능
    }
  }

  /**
   * 메시지를 context 규칙에 따라 라우팅.
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

  // ── context 처리 ─────────────────────────────────

  /** DM: humanId 발신자 메시지만 → messengerFn 또는 onMessage */
  async _routeDm(msg) {
    if (this.humanId && msg.senderId !== this.humanId) return
    await this._forward(msg)
  }

  /** Group: keywords 매칭 시 → messengerFn 또는 onMessage */
  async _routeGroup(msg) {
    if (this.keywords.length > 0) {
      const lower = msg.content.toLowerCase()
      const matched = this.keywords.some((k) => lower.includes(k))
      if (!matched) return
    }
    await this._forward(msg)
  }

  /** Cross-platform: 모든 메시지 → messengerFn */
  async _routeCrossPlatform(msg) {
    await this._forward(msg)
  }

  /** Autonomous: 모든 메시지 → onMessage만 (외부 메신저 없음) */
  async _routeAutonomous(msg) {
    if (this.onMessage) this.onMessage(msg)
  }

  /** messengerFn 호출 + onMessage 호출 */
  async _forward(msg) {
    if (this.messengerFn && this.messengerChatId) {
      try {
        await this.messengerFn(this.messengerChatId, msg.content)
      } catch (e) {
        // 포워딩 실패는 onMessage 차단 안 함
      }
    }
    if (this.onMessage) this.onMessage(msg)
  }
}

module.exports = { MessageRouter }
