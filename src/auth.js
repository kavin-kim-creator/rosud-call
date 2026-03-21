'use strict'
/**
 * auth.js — rosud-call 인증 설정 관리
 *
 * 설정 파일 위치: ~/.config/rosud-call/config.json (XDG 표준)
 * 환경변수 방식과 하위 호환 유지.
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

/** 설정 파일 경로 반환 */
function getConfigPath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdgConfig, 'rosud-call', 'config.json')
}

/** 설정 파일에서 credentials 로드. 파일 없으면 null 반환 */
function loadConfig() {
  const configPath = getConfigPath()
  try {
    if (!fs.existsSync(configPath)) return null
    const raw = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** credentials를 설정 파일에 저장 */
function saveConfig(config) {
  const configPath = getConfigPath()
  const configDir  = path.dirname(configPath)

  // 디렉터리 없으면 생성
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }

  // 설정 파일 저장 (소유자만 읽기/쓰기)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** 설정 파일 삭제 (logout) */
function deleteConfig() {
  const configPath = getConfigPath()
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath)
    return true
  }
  return false
}

/**
 * API 키 마스킹 (앞 4자리 + *** + 뒤 4자리)
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return key.slice(0, 4) + '***' + key.slice(-4)
}

/**
 * 환경변수 또는 설정 파일에서 credentials 해석.
 * 환경변수가 설정 파일보다 우선.
 * @returns {{ apiKey: string|null, botId: string|null, source: 'env'|'config'|null }}
 */
function resolveCredentials() {
  const envApiKey = process.env.BOT_MESSAGING_API_KEY
  const envBotId  = process.env.BOT_MESSAGING_BOT_ID

  // 환경변수 우선
  if (envApiKey && envBotId) {
    return { apiKey: envApiKey, botId: envBotId, source: 'env' }
  }

  // 설정 파일 로드
  const config = loadConfig()
  if (config?.apiKey && config?.botId) {
    return { apiKey: config.apiKey, botId: config.botId, source: 'config' }
  }

  return { apiKey: null, botId: null, source: null }
}

/**
 * WS 연결 테스트로 API 키 유효성 검증.
 * @param {string} apiKey
 * @param {string} botId
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}  true = 유효, false = 무효
 */
function testConnection(apiKey, botId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false

    function done(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // 3초 타임아웃 — 연결 성공 판단 기준
    const timer = setTimeout(() => {
      // 타임아웃 = 연결은 됐지만 서버 응답 없음 → 키가 잘못됐을 가능성
      // 단, 연결 자체가 열렸으면 성공으로 간주 (인증은 서버 side에서 처리)
      done(false)
    }, timeoutMs)

    let WebSocket
    try {
      WebSocket = require('ws')
    } catch {
      // ws 모듈 없으면 검증 스킵 (설치 안 된 환경)
      console.warn('[경고] ws 모듈 없음 — 연결 검증 스킵, 입력값 그대로 저장')
      clearTimeout(timer)
      done(true)
      return
    }

    const wsUrl = process.env.ROSUD_WS_URL || 'wss://api.rosud.com/bot-ws'
    // Authorization 헤더 방식 사용 (쿼리스트링 노출 방지)
    let ws
    try {
      ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } })
    } catch (err) {
      done(false)
      return
    }

    ws.on('open', () => {
      // 연결 성공 = 인증 성공
      ws.close()
      done(true)
    })

    ws.on('message', (data) => {
      // 서버에서 메시지 수신 = 연결 및 인증 성공
      try { ws.close() } catch {}
      done(true)
    })

    ws.on('error', () => {
      done(false)
    })

    ws.on('close', (code) => {
      // 4001, 4003 등 인증 오류 코드면 실패
      if (code === 4001 || code === 4003 || code === 4004) {
        done(false)
      } else if (!settled) {
        // 그 외 close (예: 1000 정상) = 성공으로 간주
        done(true)
      }
    })
  })
}

/**
 * readline으로 한 줄 입력받기
 * @param {object} rl  readline.Interface
 * @param {string} question
 * @returns {Promise<string>}
 */
function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim())
    })
  })
}

/**
 * login / init 커맨드 실행.
 * readline으로 apiKey, botId 입력받고 연결 테스트 후 저장.
 */
async function runLogin() {
  const readline = require('readline')
  const rl = readline.createInterface({
    input : process.stdin,
    output: process.stdout,
  })

  console.log('rosud-call 로그인')
  console.log('─────────────────────────────────')

  // 기존 설정 있으면 안내
  const existing = loadConfig()
  if (existing) {
    console.log(`기존 설정 발견: botId=${existing.botId}, apiKey=${maskKey(existing.apiKey)}`)
    console.log('새 설정으로 덮어씁니다.\n')
  }

  while (true) {
    const apiKey = await prompt(rl, 'API Key: ')
    if (!apiKey) {
      console.log('API Key를 입력해주세요.')
      continue
    }

    const botId = await prompt(rl, 'Bot ID: ')
    if (!botId) {
      console.log('Bot ID를 입력해주세요.')
      continue
    }

    process.stdout.write('연결 테스트 중...')
    const ok = await testConnection(apiKey, botId)

    if (ok) {
      process.stdout.write(' ✓\n')
      saveConfig({ apiKey, botId, savedAt: new Date().toISOString() })
      console.log(`\n✅ 저장 완료: ${getConfigPath()}`)
      console.log(`   botId  : ${botId}`)
      console.log(`   apiKey : ${maskKey(apiKey)}`)
      console.log('\n이제 rosud-call listen --room <room-id> 명령어를 바로 사용할 수 있습니다.')
      rl.close()
      process.exit(0)
    } else {
      process.stdout.write(' ✗\n')
      console.log('❌ API 키가 올바르지 않습니다. 다시 입력해주세요.\n')
    }
  }
}

/** whoami 커맨드: 저장된 설정 출력 */
function runWhoami() {
  const config = loadConfig()
  if (!config) {
    console.log('저장된 설정이 없습니다. `rosud-call login`으로 로그인하세요.')
    process.exit(1)
  }
  console.log('현재 로그인 정보:')
  console.log(`  botId  : ${config.botId}`)
  console.log(`  apiKey : ${maskKey(config.apiKey)}`)
  if (config.savedAt) {
    console.log(`  저장일 : ${config.savedAt}`)
  }
  console.log(`  파일   : ${getConfigPath()}`)
}

/** logout 커맨드: 설정 파일 삭제 */
function runLogout() {
  const deleted = deleteConfig()
  if (deleted) {
    console.log('✅ 로그아웃 완료. 설정 파일이 삭제되었습니다.')
  } else {
    console.log('저장된 설정이 없습니다.')
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  deleteConfig,
  maskKey,
  resolveCredentials,
  testConnection,
  runLogin,
  runWhoami,
  runLogout,
  getConfigPath,
}
