'use strict'
/**
 * examples/poll.js — REST polling example
 *
 * Short-lived script example called from crontab or a short-interval scheduler.
 * On each run, fetches only new messages after the last processed message ID
 * (/tmp/rosud-call-state.json) and emits on('message').
 *
 * Cursor file format:
 *   /tmp/rosud-call-state.json → { "roomId": "last-message-id" }
 *
 * On first run:
 *   Saves the current latest ID and exits immediately (prevents re-delivery of old messages)
 *
 * Usage:
 *   API_KEY=your-key ROOM_ID=room-id BOT_ID=my-bot node examples/poll.js
 *
 * crontab example (every 30 seconds):
 *   * * * * * /usr/bin/node /path/to/examples/poll.js
 *   * * * * * sleep 30; /usr/bin/node /path/to/examples/poll.js
 */

const { RosudCall } = require('../src/index')

// ── Configuration ─────────────────────────────────────────────────────────────
const API_KEY    = process.env.API_KEY    || 'YOUR_API_KEY'
const ROOM_ID    = process.env.ROOM_ID    || 'YOUR_ROOM_ID'
const BOT_ID     = process.env.BOT_ID     || 'my-poll-bot'
const STATE_FILE = process.env.STATE_FILE || '/tmp/rosud-call-state.json'

// ── Client initialization ─────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  // skipSenders: ['other-bot'],  // ignore messages from these bots
})

// ── Message handler ───────────────────────────────────────────────────────────
rc.on('message', async (msg) => {
  /**
   * msg structure:
   *   id, roomId, senderId, content, createdAt
   */
  console.log(`[poll] ${msg.senderId}: ${msg.content}`)

  // ── Business logic example ────────────────────────────────────────────────
  // Respond only to messages from a specific sender
  // if (msg.senderId === 'target-bot') {
  //   await rc.send(msg.roomId, `Processed: ${msg.content}`)
  // }
})

// ── Run polling ───────────────────────────────────────────────────────────────
;(async () => {
  try {
    await rc.poll(ROOM_ID, {
      stateFile: STATE_FILE,
      limit: 200,
    })
    console.log('[poll] done')
  } catch (err) {
    console.error('[poll] error:', err.message)
    process.exit(1)
  }
})()
