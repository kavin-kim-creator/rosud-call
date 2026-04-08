'use strict'
/**
 * examples/send.js — single message send example
 *
 * The simplest example: sends a message to a room once and exits.
 *
 * Duplicate send prevention:
 *   If send() is called with the same content within 60s (dedupTtlMs), it is automatically skipped.
 *   Stored as an MD5 hash in /tmp/rosud-call-dedup.json.
 *
 * Usage:
 *   API_KEY=your-key ROOM_ID=room-id node examples/send.js
 *   API_KEY=your-key ROOM_ID=room-id MSG="Hello!" node examples/send.js
 */

const { RosudCall } = require('../src/index')

// ── Configuration ─────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'YOUR_API_KEY'
const ROOM_ID = process.env.ROOM_ID || 'YOUR_ROOM_ID'
const BOT_ID  = process.env.BOT_ID  || 'my-sender-bot'
const MSG     = process.env.MSG     || `Hello from rosud-call! (${new Date().toISOString()})`

// ── Client initialization ─────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  dedupTtlMs: 60_000,  // 60s duplicate prevention (default)
})

// ── Send ──────────────────────────────────────────────────────────────────────
;(async () => {
  try {
    console.log(`[send] sending: "${MSG}"`)
    await rc.send(ROOM_ID, MSG)
    console.log('[send] sent successfully')
  } catch (err) {
    console.error('[send] failed:', err.message)
    process.exit(1)
  }
})()
