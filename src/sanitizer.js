'use strict'
/**
 * src/sanitizer.js — LLM 헤더 제거
 *
 * LLM 초안 헤더 패턴을 감지해 실제 content만 추출.
 * "Human:", "Assistant:", "System:", "---\n초안" 등 제거.
 */

// "---" 이전에 이 키워드가 있으면 헤더로 판단
const DRAFT_KEYWORDS = ['초안', 'draft', 'Draft', '브릿지 방 답장']

// 줄 단위 LLM 역할 접두사 패턴
const ROLE_PREFIX_RE = /^(Human|Assistant|System|User|AI)\s*:\s*/i

/**
 * LLM 헤더를 제거하고 실제 content만 반환.
 * @param {string} content
 * @returns {string}
 */
function sanitize(content) {
  if (!content) return content

  // "---" 구분선이 있으면 초안 헤더 여부 확인
  const sepIdx = content.indexOf('---')
  if (sepIdx !== -1) {
    const before = content.slice(0, sepIdx)
    if (DRAFT_KEYWORDS.some((k) => before.includes(k))) {
      return content.slice(sepIdx + 3).trim()
    }
  }

  // 줄 단위 LLM 역할 접두사 제거 (단일 줄 메시지)
  const trimmed = content.trimStart()
  if (ROLE_PREFIX_RE.test(trimmed)) {
    return trimmed.replace(ROLE_PREFIX_RE, '').trim()
  }

  return content
}

module.exports = { sanitize }
