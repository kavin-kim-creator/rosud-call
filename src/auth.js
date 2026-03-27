'use strict'
/**
 * auth.js — rosud-call authentication configuration manager
 *
 * Config file location: ~/.config/rosud-call/config.json (XDG standard)
 * Backward compatible with environment variable approach.
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

/** Returns the config file path */
function getConfigPath() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdgConfig, 'rosud-call', 'config.json')
}

/** Load credentials from config file. Returns null if file not found. */
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

/** Save credentials to config file */
function saveConfig(config) {
  const configPath = getConfigPath()
  const configDir  = path.dirname(configPath)

  // Create directory if it does not exist
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }

  // Save config file (owner read/write only)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** Delete config file (logout) */
function deleteConfig() {
  const configPath = getConfigPath()
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath)
    return true
  }
  return false
}

/**
 * Mask API key (first 4 chars + *** + last 4 chars)
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
  if (!key || key.length < 8) return '****'
  return key.slice(0, 4) + '***' + key.slice(-4)
}

/**
 * Resolve credentials from environment variables or config file.
 * Environment variables take priority over config file.
 * @returns {{ apiKey: string|null, botId: string|null, source: 'env'|'config'|null }}
 */
function resolveCredentials() {
  const envApiKey = process.env.BOT_MESSAGING_API_KEY
  const envBotId  = process.env.BOT_MESSAGING_BOT_ID

  // Environment variables take priority
  if (envApiKey && envBotId) {
    return { apiKey: envApiKey, botId: envBotId, source: 'env' }
  }

  // Load config file
  const config = loadConfig()
  if (config?.apiKey && config?.botId) {
    return { apiKey: config.apiKey, botId: config.botId, source: 'config' }
  }

  return { apiKey: null, botId: null, source: null }
}

/**
 * Validate API key by testing WS connection.
 * @param {string} apiKey
 * @param {string} botId
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}  true = valid, false = invalid
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

    // 3-second timeout — connection success threshold
    const timer = setTimeout(() => {
      // Timeout = connected but no server response → key may be wrong
      // However, if the connection itself opened, treat as success (auth is handled server-side)
      done(false)
    }, timeoutMs)

    let WebSocket
    try {
      WebSocket = require('ws')
    } catch {
      // ws module not found — skip validation (not installed in this environment)
      console.warn('[warning] ws module not found — skipping connection validation, saving input as-is')
      clearTimeout(timer)
      done(true)
      return
    }

    const wsUrl = process.env.ROSUD_WS_URL || 'wss://api.rosud.com/bot-ws'
    // Use Authorization header (avoid exposing key in query string)
    let ws
    try {
      ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } })
    } catch (err) {
      done(false)
      return
    }

    ws.on('open', () => {
      // Connection successful = authentication successful
      ws.close()
      done(true)
    })

    ws.on('message', (data) => {
      // Message received from server = connection and authentication successful
      try { ws.close() } catch {}
      done(true)
    })

    ws.on('error', () => {
      done(false)
    })

    ws.on('close', (code) => {
      // Auth error codes (4001, 4003, etc.) → failure
      if (code === 4001 || code === 4003 || code === 4004) {
        done(false)
      } else if (!settled) {
        // Other close codes (e.g. 1000 normal) = treat as success
        done(true)
      }
    })
  })
}

/**
 * Read a single line of input via readline
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
 * Run the login / init command.
 * Prompts for apiKey and botId via readline, tests connection, then saves.
 */
async function runLogin() {
  const readline = require('readline')
  const rl = readline.createInterface({
    input : process.stdin,
    output: process.stdout,
  })

  console.log('rosud-call login')
  console.log('─────────────────────────────────')

  // Notify if existing config is found
  const existing = loadConfig()
  if (existing) {
    console.log(`Existing config found: botId=${existing.botId}, apiKey=${maskKey(existing.apiKey)}`)
    console.log('Overwriting with new settings.\n')
  }

  while (true) {
    const apiKey = await prompt(rl, 'API Key: ')
    if (!apiKey) {
      console.log('Please enter your API Key.')
      continue
    }

    const botId = await prompt(rl, 'Bot ID: ')
    if (!botId) {
      console.log('Please enter your Bot ID.')
      continue
    }

    process.stdout.write('Testing connection...')
    const ok = await testConnection(apiKey, botId)

    if (ok) {
      process.stdout.write(' ✓\n')
      saveConfig({ apiKey, botId, savedAt: new Date().toISOString() })
      console.log(`\n✅ Saved: ${getConfigPath()}`)
      console.log(`   botId  : ${botId}`)
      console.log(`   apiKey : ${maskKey(apiKey)}`)
      console.log('\nYou can now use `rosud-call listen --room <room-id>` without setting env vars.')
      rl.close()
      process.exit(0)
    } else {
      process.stdout.write(' ✗\n')
      console.log('❌ Invalid API key. Please try again.\n')
    }
  }
}

/** whoami command: print saved config */
function runWhoami() {
  const config = loadConfig()
  if (!config) {
    console.log('No saved config found. Run `rosud-call login` to log in.')
    process.exit(1)
  }
  console.log('Current login info:')
  console.log(`  botId  : ${config.botId}`)
  console.log(`  apiKey : ${maskKey(config.apiKey)}`)
  if (config.savedAt) {
    console.log(`  savedAt: ${config.savedAt}`)
  }
  console.log(`  file   : ${getConfigPath()}`)
}

/** logout command: delete config file */
function runLogout() {
  const deleted = deleteConfig()
  if (deleted) {
    console.log('✅ Logged out. Config file deleted.')
  } else {
    console.log('No saved config found.')
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
