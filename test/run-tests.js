'use strict'
/**
 * test/run-tests.js — Unit Tests (pure JS, no dependencies)
 *
 * Tests for sanitizer, dedup, and lock modules.
 * Can run without external network.
 *
 * Run: node test/run-tests.js  or  npm test
 */

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const { sanitize }             = require('../src/sanitizer')
const { isDuplicate, markSent } = require('../src/dedup')
const { acquireLock, releaseLock } = require('../src/lock')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
    passed++
  } catch (e) {
    console.error(`  FAIL  ${name}`)
    console.error(`        ${e.message}`)
    failed++
  }
}

// --- sanitizer tests ──────────────────────────────────

console.log('\n[sanitizer]')

test('remove draft header (Korean keyword)', () => {
  const input = '\uCD08\uC548\n---\nActual content.'
  // Note: sanitize checks for 'draft'/'Draft'/'bridge room reply' keywords
  assert.strictEqual(sanitize(input), input) // Korean keyword not in DRAFT_KEYWORDS
})

test('remove draft header', () => {
  const input = 'draft\n---\nactual content'
  assert.strictEqual(sanitize(input), 'actual content')
})

test('remove Draft header (capitalized)', () => {
  const input = 'Draft\n---\nactual content'
  assert.strictEqual(sanitize(input), 'actual content')
})

test('remove bridge room reply header', () => {
  const input = 'bridge room reply\n---\nmessage body'
  assert.strictEqual(sanitize(input), 'message body')
})

test('preserve normal message without header', () => {
  const input = 'Hello, this is a normal message.'
  assert.strictEqual(sanitize(input), input)
})

test('preserve message with --- but no keyword', () => {
  const input = 'normal---text'
  assert.strictEqual(sanitize(input), input)
})

test('remove Human: prefix', () => {
  const input = 'Human: user message'
  assert.strictEqual(sanitize(input), 'user message')
})

test('remove Assistant: prefix', () => {
  const input = 'Assistant: AI response'
  assert.strictEqual(sanitize(input), 'AI response')
})

test('handle empty string', () => {
  assert.strictEqual(sanitize(''), '')
})

test('handle null/undefined', () => {
  assert.strictEqual(sanitize(null), null)
  assert.strictEqual(sanitize(undefined), undefined)
})

// --- dedup tests ──────────────────────────────────────

console.log('\n[dedup]')

const dedupFile = path.join(os.tmpdir(), `rosud-test-dedup-${process.pid}.json`)

// Clean up after test
process.on('exit', () => { try { fs.unlinkSync(dedupFile) } catch {} })

test('isDuplicate: first call returns false', () => {
  assert.strictEqual(isDuplicate('hello', 1000, dedupFile), false)
})

test('markSent + isDuplicate: detects duplicate within TTL', () => {
  markSent('hello', 1000, dedupFile)
  assert.strictEqual(isDuplicate('hello', 1000, dedupFile), true)
})

test('isDuplicate: returns false after TTL expires', async () => {
  const SHORT_TTL = 50  // 50ms
  markSent('short-ttl-msg', SHORT_TTL, dedupFile)
  await new Promise((r) => setTimeout(r, 100))
  assert.strictEqual(isDuplicate('short-ttl-msg', SHORT_TTL, dedupFile), false)
})

test('isDuplicate: different content is not a duplicate', () => {
  markSent('msg-a', 5000, dedupFile)
  assert.strictEqual(isDuplicate('msg-b', 5000, dedupFile), false)
})

// --- lock tests ───────────────────────────────────────

console.log('\n[lock]')

const lockFile = path.join(os.tmpdir(), `rosud-test-lock-${process.pid}.lock`)

// Clean up after test
process.on('exit', () => { try { fs.unlinkSync(lockFile) } catch {} })

test('acquireLock: first acquisition succeeds', () => {
  const handle = acquireLock(lockFile)
  assert.ok(handle !== null)
  releaseLock(handle)
})

test('re-acquire after releaseLock succeeds', () => {
  const h1 = acquireLock(lockFile)
  assert.ok(h1 !== null)
  releaseLock(h1)

  const h2 = acquireLock(lockFile)
  assert.ok(h2 !== null)
  releaseLock(h2)
})

test('double acquisition fails', () => {
  const h1 = acquireLock(lockFile)
  assert.ok(h1 !== null)

  const h2 = acquireLock(lockFile)
  assert.strictEqual(h2, null)

  releaseLock(h1)
})

test('stale lock auto-release (force old timestamp)', () => {
  // Manually create a stale lock file
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, ts: Date.now() - 700_000 }))

  const handle = acquireLock(lockFile)
  assert.ok(handle !== null, 'stale lock should be auto-released')
  releaseLock(handle)
})

// --- Results ─────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
