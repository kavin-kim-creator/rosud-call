'use strict'
/**
 * src/dedup.js — deduplication cache for outgoing messages (file-based, TTL)
 *
 * Uses MD5 hash of content as key.
 * Entries expire automatically after TTL.
 */

const fs     = require('fs')
const crypto = require('crypto')

const DEFAULT_TTL_MS   = 60_000                      // 60 seconds
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
 * Check if the same content was already sent within the TTL window.
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
 * Mark content as "sent". Cleans up expired entries at the same time.
 * @param {string} content
 * @param {number} [ttlMs]
 * @param {string} [cacheFile]
 */
function markSent(content, ttlMs = DEFAULT_TTL_MS, cacheFile = DEFAULT_CACHE) {
  const cache = _load(cacheFile)
  const key   = _hash(content)
  cache[key]  = Date.now()

  // Clean up expired entries
  const now = Date.now()
  for (const k of Object.keys(cache)) {
    if (now - cache[k] > ttlMs) delete cache[k]
  }

  _save(cacheFile, cache)
}

module.exports = { isDuplicate, markSent }
