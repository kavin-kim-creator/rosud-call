'use strict'
/**
 * src/poller.js — REST 폴링 로직
 *
 * 버그 대응:
 *  #1  limit=30 → 구 메시지 재전송   → 내부 limit=200 + ID 루프
 *  #2  after 커서 역방향             → after 파라미터 절대 사용 금지
 *
 * 동작:
 *  - limit=200 고정으로 최신 메시지 목록 조회
 *  - last_id 이후 메시지만 콜백 호출
 *  - last_id 없으면 최신 ID 저장 후 종료 (초기화 전용)
 *  - last_id가 조회 범위 초과 시 재전송 없이 최신 ID 갱신
 */

const fs = require('fs')

const LIMIT = 200

class Poller {
  /**
   * @param {object} options
   * @param {import('./client').ApiClient} options.client
   * @param {string}   options.botId
   * @param {Set<string>} options.skipSenders
   * @param {boolean}  [options.filterSelf=true]  true면 botId 발신 메시지 필터
   * @param {Function} options.onMessage  (msg) => void
   * @param {Function} [options.toMsg]    내부 메시지 변환 함수
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
   * 1회 폴링 실행.
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
      // 최초 실행: 현재 최신 저장 후 종료 (과거 메시지 재전송 방지)
      this._saveState(stateFile, roomId, messages[messages.length - 1].id)
      return
    }

    // last_id 이후 메시지 수집 (index 0 = oldest)
    let found   = false
    const newMsgs = []
    for (const m of messages) {
      if (found) newMsgs.push(m)
      if (m.id === lastId) found = true
    }

    if (!found) {
      // last_id가 조회 범위 밖 → 재전송 금지, 최신 ID만 갱신
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

  // ── state 파일 ────────────────────────────────────

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
