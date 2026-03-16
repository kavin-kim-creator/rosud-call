'use strict'
/**
 * src/dedup.js — 중복 발신 방지 캐시 (파일 기반, TTL)
 *
 * content의 MD5 해시를 키로 사용.
 * TTL 초과 시 자동 만료.
 */

const fs     = require('fs')
const crypto = require('crypto')

const DEFAULT_TTL_MS   = 60_000                      // 60초
const DEFAULT_CACHE    = '/tmp/rosud-call-dedup.json'

function _hash(content) {
  return crypto.createHash('md5').update(content).digest('hex')
}

function _load(cacheFile) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }
  catch { return {} }
}

function _save(cacheFile, cache) {
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch {}
}

/**
 * 동일 content가 TTL 내에 이미 전송됐는지 확인.
 * @param {string} content
 * @param {number} [ttlMs]
 * @param {string} [cacheFile]
 * @returns {boolean}
 */
function isDuplicate(content, ttlMs = DEFAULT_TTL_MS, cacheFile = DEFAULT_CACHE) {
  const cache = _load(cacheFile)
  const key   = _hash(content)
  const ts    = cache[key]
  return !!(ts && Date.now() - ts < ttlMs)
}

/**
 * content를 "전송 완료"로 표시. TTL 초과 항목 동시 정리.
 * @param {string} content
 * @param {number} [ttlMs]
 * @param {string} [cacheFile]
 */
function markSent(content, ttlMs = DEFAULT_TTL_MS, cacheFile = DEFAULT_CACHE) {
  const cache = _load(cacheFile)
  const key   = _hash(content)
  cache[key]  = Date.now()

  // TTL 초과 항목 정리
  const now = Date.now()
  for (const k of Object.keys(cache)) {
    if (now - cache[k] > ttlMs) delete cache[k]
  }

  _save(cacheFile, cache)
}

module.exports = { isDuplicate, markSent }
