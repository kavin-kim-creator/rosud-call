'use strict'
/**
 * test/run-tests.js — Unit Tests (의존성 없는 순수 JS 테스트)
 *
 * sanitizer, dedup, lock 모듈 테스트.
 * 외부 네트워크 없이 실행 가능.
 *
 * 실행: node test/run-tests.js  또는  npm test
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

// ── sanitizer 테스트 ──────────────────────────────────

console.log('\n[sanitizer]')

test('초안 헤더 제거', () => {
  const input = '초안\n---\n실제 내용입니다.'
  assert.strictEqual(sanitize(input), '실제 내용입니다.')
})

test('draft 헤더 제거', () => {
  const input = 'draft\n---\nactual content'
  assert.strictEqual(sanitize(input), 'actual content')
})

test('Draft 헤더 제거 (대문자)', () => {
  const input = 'Draft\n---\nactual content'
  assert.strictEqual(sanitize(input), 'actual content')
})

test('브릿지 방 답장 헤더 제거', () => {
  const input = '브릿지 방 답장\n---\n메시지 본문'
  assert.strictEqual(sanitize(input), '메시지 본문')
})

test('헤더 없는 일반 메시지 유지', () => {
  const input = '안녕하세요, 일반 메시지입니다.'
  assert.strictEqual(sanitize(input), input)
})

test('--- 있어도 키워드 없으면 유지', () => {
  const input = '일반---텍스트'
  assert.strictEqual(sanitize(input), input)
})

test('Human: 접두사 제거', () => {
  const input = 'Human: 사용자 메시지'
  assert.strictEqual(sanitize(input), '사용자 메시지')
})

test('Assistant: 접두사 제거', () => {
  const input = 'Assistant: AI 응답'
  assert.strictEqual(sanitize(input), 'AI 응답')
})

test('빈 문자열 처리', () => {
  assert.strictEqual(sanitize(''), '')
})

test('null/undefined 처리', () => {
  assert.strictEqual(sanitize(null), null)
  assert.strictEqual(sanitize(undefined), undefined)
})

// ── dedup 테스트 ──────────────────────────────────────

console.log('\n[dedup]')

const dedupFile = path.join(os.tmpdir(), `rosud-test-dedup-${process.pid}.json`)

// 테스트 후 정리
process.on('exit', () => { try { fs.unlinkSync(dedupFile) } catch {} })

test('isDuplicate: 첫 호출은 false', () => {
  assert.strictEqual(isDuplicate('hello', 1000, dedupFile), false)
})

test('markSent + isDuplicate: TTL 내 중복 감지', () => {
  markSent('hello', 1000, dedupFile)
  assert.strictEqual(isDuplicate('hello', 1000, dedupFile), true)
})

test('isDuplicate: TTL 초과 후 false', async () => {
  const SHORT_TTL = 50  // 50ms
  markSent('short-ttl-msg', SHORT_TTL, dedupFile)
  await new Promise((r) => setTimeout(r, 100))
  assert.strictEqual(isDuplicate('short-ttl-msg', SHORT_TTL, dedupFile), false)
})

test('isDuplicate: 다른 content는 중복 아님', () => {
  markSent('msg-a', 5000, dedupFile)
  assert.strictEqual(isDuplicate('msg-b', 5000, dedupFile), false)
})

// ── lock 테스트 ───────────────────────────────────────

console.log('\n[lock]')

const lockFile = path.join(os.tmpdir(), `rosud-test-lock-${process.pid}.lock`)

// 테스트 후 정리
process.on('exit', () => { try { fs.unlinkSync(lockFile) } catch {} })

test('acquireLock: 처음 획득 성공', () => {
  const handle = acquireLock(lockFile)
  assert.ok(handle !== null)
  releaseLock(handle)
})

test('releaseLock 후 재획득 가능', () => {
  const h1 = acquireLock(lockFile)
  assert.ok(h1 !== null)
  releaseLock(h1)

  const h2 = acquireLock(lockFile)
  assert.ok(h2 !== null)
  releaseLock(h2)
})

test('이중 획득 실패', () => {
  const h1 = acquireLock(lockFile)
  assert.ok(h1 !== null)

  const h2 = acquireLock(lockFile)
  assert.strictEqual(h2, null)

  releaseLock(h1)
})

test('stale lock 자동 해제 (강제 오래된 타임스탬프)', () => {
  // stale lock 파일 수동 생성
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, ts: Date.now() - 700_000 }))

  const handle = acquireLock(lockFile)
  assert.ok(handle !== null, 'stale lock은 자동 해제되어야 함')
  releaseLock(handle)
})

// ── 결과 ─────────────────────────────────────────────

console.log(`\n결과: ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
