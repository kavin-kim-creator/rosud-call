'use strict'
/**
 * src/lock.js — 파일 기반 프로세스 Lock
 *
 * flock() 스타일의 파일 lock.
 * - stale lock 자동 해제: 600초(10분) 초과 시 강제 해제
 * - lock 파일에 PID + timestamp 기록
 */

const fs   = require('fs')
const path = require('path')

const STALE_TIMEOUT_MS = 600_000  // 10분

/**
 * lock 획득 시도.
 * @param {string} lockFile  lock 파일 경로
 * @returns {{ fd: number, path: string } | null}  성공 시 lock 핸들, 실패 시 null
 */
function acquireLock(lockFile) {
  // stale lock 확인
  if (fs.existsSync(lockFile)) {
    try {
      const raw   = fs.readFileSync(lockFile, 'utf8')
      const info  = JSON.parse(raw)
      const age   = Date.now() - (info.ts || 0)

      if (age < STALE_TIMEOUT_MS) {
        // 유효한 lock — 획득 실패
        return null
      }
      // stale → 강제 삭제
      fs.unlinkSync(lockFile)
    } catch {
      // 읽기/파싱 실패 → stale로 간주, 덮어쓰기
    }
  }

  // lock 파일 생성 (exclusive write — 경쟁 조건 최소화)
  try {
    const fd = fs.openSync(lockFile, 'wx')  // O_CREAT | O_EXCL
    const info = JSON.stringify({ pid: process.pid, ts: Date.now() })
    fs.writeSync(fd, info)
    return { fd, path: lockFile }
  } catch (e) {
    if (e.code === 'EEXIST') return null  // 다른 프로세스가 먼저 획득
    throw e
  }
}

/**
 * lock 해제.
 * @param {{ fd: number, path: string }} lockHandle  acquireLock() 반환값
 */
function releaseLock(lockHandle) {
  if (!lockHandle) return
  try { fs.closeSync(lockHandle.fd) } catch {}
  try { fs.unlinkSync(lockHandle.path) } catch {}
}

module.exports = { acquireLock, releaseLock }
