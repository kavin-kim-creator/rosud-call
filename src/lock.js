'use strict'
/**
 * src/lock.js — File-based process lock
 *
 * flock()-style file lock.
 * - Stale lock auto-release: force-release after 600s (10 min)
 * - Lock file stores PID + timestamp
 */

const fs   = require('fs')
const path = require('path')

const STALE_TIMEOUT_MS = 600_000  // 10 minutes

/**
 * Attempt to acquire a lock.
 * @param {string} lockFile  Lock file path
 * @returns {{ fd: number, path: string } | null}  Lock handle on success, null on failure
 */
function acquireLock(lockFile) {
  // Check for stale lock
  if (fs.existsSync(lockFile)) {
    try {
      const raw   = fs.readFileSync(lockFile, 'utf8')
      const info  = JSON.parse(raw)
      const age   = Date.now() - (info.ts || 0)

      if (age < STALE_TIMEOUT_MS) {
        // Valid lock — acquisition failed
        return null
      }
      // Stale → force delete
      fs.unlinkSync(lockFile)
    } catch {
      // Read/parse failure → treat as stale, overwrite
    }
  }

  // Create lock file (exclusive write — minimize race conditions)
  try {
    const fd = fs.openSync(lockFile, 'wx')  // O_CREAT | O_EXCL
    const info = JSON.stringify({ pid: process.pid, ts: Date.now() })
    fs.writeSync(fd, info)
    return { fd, path: lockFile }
  } catch (e) {
    if (e.code === 'EEXIST') return null  // Another process acquired first
    throw e
  }
}

/**
 * Release a lock.
 * @param {{ fd: number, path: string }} lockHandle  Return value from acquireLock()
 */
function releaseLock(lockHandle) {
  if (!lockHandle) return
  try { fs.closeSync(lockHandle.fd) } catch {}
  try { fs.unlinkSync(lockHandle.path) } catch {}
}

module.exports = { acquireLock, releaseLock }
