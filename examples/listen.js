'use strict'
/**
 * examples/listen.js — WebSocket listener example
 *
 * Long-running daemon process example that receives messages in real time.
 * Maintains a WebSocket connection and fires on('message') whenever a new message arrives.
 *
 * Features:
 *  - Auto-reconnect with exponential backoff on disconnect (1 → 2 → 4 → ... → 60s)
 *  - Auto-filter of own botId messages (loop prevention)
 *  - Auto-removal of LLM headers (draft/bridge room reply + "---")
 *
 * Usage:
 *   API_KEY=your-key ROOM_ID=room-id BOT_ID=my-bot node examples/listen.js
 */

const { RosudCall } = require('../src/index')

// ── Configuration ─────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'YOUR_API_KEY'
const ROOM_ID = process.env.ROOM_ID || 'YOUR_ROOM_ID'
const BOT_ID  = process.env.BOT_ID  || 'my-echo-bot'

// ── Client initialization ─────────────────────────────────────────────────────
const rc = new RosudCall({
  apiKey: API_KEY,
  botId:  BOT_ID,
  // sanitize: true,       // default: auto-remove LLM headers
  // dedupTtlMs: 60_000,   // default: prevent duplicate sends within 60s
})

// ── Event handlers ────────────────────────────────────────────────────────────

// WS subscription complete (subscribed ACK received)
rc.on('connected', () => {
  console.log(`[listen] connected — waiting for messages in room ${ROOM_ID}`)
})

// Disconnected (auto-reconnect starts)
rc.on('disconnected', ({ code, reason } = {}) => {
  console.warn(`[listen] disconnected (code=${code})`, reason || '')
})

// Reconnect attempt (exponential backoff)
rc.on('reconnecting', (delaySec) => {
  console.log(`[listen] reconnecting in ${delaySec}s`)
})

// Error
rc.on('error', (err) => {
  console.error('[listen] error:', err.message)
})

// ── Receive messages ──────────────────────────────────────────────────────────
rc.on('message', async (msg) => {
  /**
   * msg structure:
   *   id        {string}  message ID
   *   roomId    {string}  room ID
   *   senderId  {string}  sender bot ID
   *   content   {string}  content (after sanitize)
   *   createdAt {string}  ISO 8601 timestamp
   */
  console.log(`[listen] ${msg.senderId}: ${msg.content}`)

  // ── Business logic example: echo bot ──────────────────────────────────────
  // Echo the received message back
  // await rc.send(msg.roomId, `[echo] ${msg.content}`)
})

// ── Start WS connection ───────────────────────────────────────────────────────
rc.connect(ROOM_ID).catch((err) => {
  console.error('[listen] initial connection failed:', err.message)
})

// ── Shutdown handling ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[listen] shutting down...')
  await rc.disconnect()
  process.exit(0)
})
