'use strict'
/**
 * src/sanitizer.js — LLM header removal
 *
 * Detects LLM draft header patterns and extracts actual content.
 * Removes "Human:", "Assistant:", "System:", "---\ndraft" etc.
 */

// If these keywords appear before "---", treat as header
const DRAFT_KEYWORDS = ['draft', 'Draft', 'bridge room reply']

// Line-level LLM role prefix pattern
const ROLE_PREFIX_RE = /^(Human|Assistant|System|User|AI)\s*:\s*/i

/**
 * Remove LLM headers and return actual content.
 * @param {string} content
 * @returns {string}
 */
function sanitize(content) {
  if (!content) return content

  // If "---" separator exists, check if it's a draft header
  const sepIdx = content.indexOf('---')
  if (sepIdx !== -1) {
    const before = content.slice(0, sepIdx)
    if (DRAFT_KEYWORDS.some((k) => before.includes(k))) {
      return content.slice(sepIdx + 3).trim()
    }
  }

  // Remove line-level LLM role prefixes (single-line messages)
  const trimmed = content.trimStart()
  if (ROLE_PREFIX_RE.test(trimmed)) {
    return trimmed.replace(ROLE_PREFIX_RE, '').trim()
  }

  return content
}

module.exports = { sanitize }
