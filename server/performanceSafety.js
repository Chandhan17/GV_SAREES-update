import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

export const PERFORMANCE_PROJECT_ID = 'demo-gv-sarees'
export const PERFORMANCE_FIRESTORE_HOST = '127.0.0.1:8080'
export const PERFORMANCE_EMULATOR_HUB_HOST = '127.0.0.1:4400'
export const PERFORMANCE_AUTH_HOST = '127.0.0.1:9099'
export const PERFORMANCE_API_TARGET = 'http://127.0.0.1:3001'
export const PERFORMANCE_API_RUNTIME_ENV = 'GV_PERFORMANCE_API_RUNTIME'
export const PERFORMANCE_API_RUNTIME_HEADER = 'x-performance-api-runtime'
export const PERFORMANCE_API_STARTUP_HEADER = 'x-performance-runtime-startup-ms'
export const PERFORMANCE_API_RUNTIME_IDS = Object.freeze({
  persistent: 'persistent',
  vercel: 'vercel',
})

const safePerformanceApiMessages = new Set([
  'API route working',
  'Performance environment safety checks failed.',
])

const requiredTelegramKeys = [
  'TELEGRAM_TEST_MODE',
  'TELEGRAM_TEST_BOT_USERNAME',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID',
]
const requiredFirebaseKeys = [
  'FIREBASE_PROJECT_ID',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIRESTORE_EMULATOR_HOST',
  'VITE_FIREBASE_AUTH_EMULATOR_HOST',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]
const requiredReservationKeys = ['RESERVATION_TOKEN_SECRET']
const requiredRazorpayKeys = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'VITE_RAZORPAY_KEY_ID',
]

export function parseEnvText(contents) {
  const values = {}

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }

  return values
}

export function readEnvFile(path, { optional = true } = {}) {
  try {
    return parseEnvText(readFileSync(path, 'utf8'))
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {}
    throw new Error('Unable to read the required environment configuration.')
  }
}

export function readPerformanceEnvironment(root = process.cwd()) {
  return readEnvFile(resolve(root, '.env.performance.local'), { optional: false })
}

export function readProductionTelegramEnvironments(root = process.cwd()) {
  return ['.env', '.env.local', '.env.build']
    .map((name) => readEnvFile(resolve(root, name)))
}

function assertRequiredValues(env, keys) {
  for (const key of keys) {
    if (!String(env[key] || '').trim()) {
      throw new Error('Performance mode safety configuration is incomplete.')
    }
  }
}

export function resolvePerformanceEnvironment({
  env,
  explicitEnv,
  productionEnvironments = [],
}) {
  const protectedKeys = new Set([
    ...requiredTelegramKeys,
    ...requiredFirebaseKeys,
    ...requiredReservationKeys,
    ...requiredRazorpayKeys,
  ])
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_')) protectedKeys.add(key)
  }

  const conflicts = [...protectedKeys].filter((key) => (
    env[key] !== undefined &&
    env[key] !== explicitEnv[key] &&
    !productionEnvironments.some((production) => production[key] === env[key])
  ))
  if (conflicts.length) {
    throw new Error(
      `Performance mode has conflicting inherited variables: ${conflicts.join(', ')}.`,
    )
  }

  const performanceEnv = { ...env }
  for (const key of Object.keys(performanceEnv)) {
    if (key.startsWith('VITE_') &&
        !Object.prototype.hasOwnProperty.call(explicitEnv, key)) {
      delete performanceEnv[key]
    }
  }
  Object.assign(performanceEnv, explicitEnv)
  return performanceEnv
}

function assertLoopbackHost(value, expected) {
  if (value !== expected) {
    throw new Error('Performance mode requires the configured local Firebase Emulator.')
  }
}

export function validatePerformanceConfiguration({
  mode,
  env,
  explicitEnv,
  productionEnvironments = [],
}) {
  if (mode !== 'performance') {
    throw new Error('Performance mode configuration was used outside performance mode.')
  }

  const requiredKeys = [
    ...requiredTelegramKeys,
    ...requiredFirebaseKeys,
    ...requiredReservationKeys,
    ...requiredRazorpayKeys,
  ]
  assertRequiredValues(explicitEnv, requiredKeys)
  assertRequiredValues(env, requiredKeys)

  for (const key of requiredKeys) {
    if (env[key] !== explicitEnv[key]) {
      throw new Error('Performance mode must use values explicitly set in .env.performance.local.')
    }
  }

  if (Buffer.byteLength(env.RESERVATION_TOKEN_SECRET, 'utf8') < 32) {
    throw new Error('Performance mode requires a reservation token secret of at least 32 bytes.')
  }
  if (!env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    throw new Error('Performance mode requires Razorpay test-mode credentials.')
  }
  if (env.VITE_RAZORPAY_KEY_ID !== env.RAZORPAY_KEY_ID) {
    throw new Error('Performance Razorpay public and server test key IDs must match.')
  }

  if (env.TELEGRAM_TEST_MODE !== '1') {
    throw new Error('Performance mode requires TELEGRAM_TEST_MODE=1.')
  }

  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN)) {
    throw new Error('Performance mode requires a valid dedicated Telegram test bot token.')
  }
  if (!/^-100\d{5,}$/.test(env.TELEGRAM_CHANNEL_ID)) {
    throw new Error('Performance mode requires a private Telegram test channel ID.')
  }
  if (env.FIREBASE_PROJECT_ID !== PERFORMANCE_PROJECT_ID ||
      env.VITE_FIREBASE_PROJECT_ID !== PERFORMANCE_PROJECT_ID) {
    throw new Error('Performance mode requires the demo-gv-sarees Firebase project.')
  }

  assertLoopbackHost(env.FIRESTORE_EMULATOR_HOST, PERFORMANCE_FIRESTORE_HOST)
  assertLoopbackHost(env.VITE_FIRESTORE_EMULATOR_HOST, PERFORMANCE_FIRESTORE_HOST)
  assertLoopbackHost(env.FIREBASE_AUTH_EMULATOR_HOST, PERFORMANCE_AUTH_HOST)
  assertLoopbackHost(env.VITE_FIREBASE_AUTH_EMULATOR_HOST, PERFORMANCE_AUTH_HOST)

  for (const production of productionEnvironments) {
    if ((production.TELEGRAM_BOT_TOKEN &&
         production.TELEGRAM_BOT_TOKEN === env.TELEGRAM_BOT_TOKEN) ||
        (production.TELEGRAM_CHANNEL_ID &&
         production.TELEGRAM_CHANNEL_ID === env.TELEGRAM_CHANNEL_ID)) {
      throw new Error('Performance Telegram settings must not match production resources.')
    }
    if (production.RESERVATION_TOKEN_SECRET &&
        production.RESERVATION_TOKEN_SECRET === env.RESERVATION_TOKEN_SECRET) {
      throw new Error('Performance reservation token secret must not match production configuration.')
    }
    if (
      (production.RAZORPAY_KEY_ID &&
       production.RAZORPAY_KEY_ID === env.RAZORPAY_KEY_ID) ||
      (production.VITE_RAZORPAY_KEY_ID &&
       production.VITE_RAZORPAY_KEY_ID === env.VITE_RAZORPAY_KEY_ID) ||
      (production.RAZORPAY_KEY_SECRET &&
       production.RAZORPAY_KEY_SECRET === env.RAZORPAY_KEY_SECRET)
    ) {
      throw new Error('Performance Razorpay credentials must not match production configuration.')
    }
  }

  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramUsername: String(env.TELEGRAM_TEST_BOT_USERNAME).replace(/^@/, '').toLowerCase(),
    telegramChannelId: env.TELEGRAM_CHANNEL_ID,
    firestoreHost: env.FIRESTORE_EMULATOR_HOST,
    authHost: env.FIREBASE_AUTH_EMULATOR_HOST,
    projectId: PERFORMANCE_PROJECT_ID,
  }
}

export function assertServerPerformanceConfiguration(env = process.env, root = process.cwd()) {
  if (env.APP_MODE !== 'performance') {
    throw new Error('Performance mode is not explicitly enabled.')
  }

  const explicitEnv = readPerformanceEnvironment(root)
  const productionEnvironments = readProductionTelegramEnvironments(root)
  const performanceEnv = resolvePerformanceEnvironment({
    env,
    explicitEnv,
    productionEnvironments,
  })

  validatePerformanceConfiguration({
    mode: env.APP_MODE,
    env: performanceEnv,
    explicitEnv,
    productionEnvironments,
  })

  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_') &&
        !Object.prototype.hasOwnProperty.call(explicitEnv, key)) {
      delete env[key]
    }
  }
  Object.assign(env, performanceEnv)

  if (env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      env.FIREBASE_CLIENT_EMAIL ||
      env.FIREBASE_PRIVATE_KEY ||
      env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Production Firebase credentials are not allowed in performance mode.')
  }

  return true
}

export function getPerformanceApiRuntimeIdentity(env = process.env) {
  if (env.APP_MODE !== 'performance' ||
      env[PERFORMANCE_API_RUNTIME_ENV] !== PERFORMANCE_API_RUNTIME_IDS.vercel ||
      env.VERCEL !== '1' ||
      env.VERCEL_ENV !== 'development') {
    return null
  }
  return PERFORMANCE_API_RUNTIME_IDS.vercel
}

function telegramVerificationError(operation, category) {
  return new Error(`Telegram ${operation} verification failed: ${category}.`)
}

function getTelegramNetworkFailureCategory(error) {
  const name = error?.name
  const code = String(error?.code || error?.cause?.code || '').toUpperCase()
  const timeoutCodes = new Set([
    'ETIMEDOUT',
    'ERR_REQUEST_TIMEOUT',
    'ERR_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ])
  return name === 'TimeoutError' ||
    name === 'AbortError' ||
    timeoutCodes.has(code)
    ? 'timeout'
    : 'network/connection failure'
}

async function telegramRequest(token, operation, data, fetchImpl) {
  let response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw telegramVerificationError(
      operation,
      getTelegramNetworkFailureCategory(error),
    )
  }

  let result
  try {
    result = await response.json()
  } catch {
    result = null
  }
  if (!response.ok || !result?.ok) {
    throw telegramVerificationError(operation, 'Telegram API rejection')
  }
  return result.result
}

export async function verifyTelegramTestResources(config, fetchImpl = fetch) {
  if (!config?.telegramToken || !config.telegramUsername) {
    throw telegramVerificationError('getMe', 'configuration is incomplete')
  }
  if (!config.telegramChannelId) {
    throw telegramVerificationError('getChat', 'configuration is incomplete')
  }

  const bot = await telegramRequest(config.telegramToken, 'getMe', {}, fetchImpl)
  if (!bot || String(bot.username || '').toLowerCase() !== config.telegramUsername) {
    throw telegramVerificationError('getMe', 'identity validation mismatch')
  }

  const channel = await telegramRequest(
    config.telegramToken,
    'getChat',
    { chat_id: config.telegramChannelId },
    fetchImpl,
  )
  if (!channel ||
      channel.type !== 'channel' ||
      channel.username ||
      !/test/i.test(channel.title || '')) {
    throw telegramVerificationError('getChat', 'resource validation mismatch')
  }

  const membership = await telegramRequest(
    config.telegramToken,
    'getChatMember',
    { chat_id: config.telegramChannelId, user_id: bot.id },
    fetchImpl,
  )
  if (!membership ||
      !['administrator', 'creator'].includes(membership.status) ||
      membership.can_post_messages !== true) {
    throw telegramVerificationError('getChatMember', 'permission failure')
  }

  return true
}

export async function verifyFirestoreEmulator({
  projectId = PERFORMANCE_PROJECT_ID,
  emulatorHost = PERFORMANCE_FIRESTORE_HOST,
  fetchImpl = fetch,
} = {}) {
  if (projectId !== PERFORMANCE_PROJECT_ID || emulatorHost !== PERFORMANCE_FIRESTORE_HOST) {
    throw new Error('The configured Firebase Emulator could not be verified.')
  }

  let response
  try {
    // The Emulator Hub status endpoint avoids document reads governed by Firestore rules.
    response = await fetchImpl(`http://${PERFORMANCE_EMULATOR_HUB_HOST}/emulators`, {
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    throw new Error('Firebase Emulator connectivity could not be verified.')
  }

  if (!response.ok || response.status !== 200) {
    throw new Error('Firebase Emulator connectivity could not be verified.')
  }

  const result = await response.json().catch(() => null)
  const firestore = result?.firestore
  const listensOnConfiguredLoopback = Array.isArray(firestore?.listen) &&
    firestore.listen.some((listener) => (
      listener?.address === '127.0.0.1' &&
      listener?.port === 8080
    ))

  if (firestore?.name !== 'firestore' ||
      firestore.host !== '127.0.0.1' ||
      firestore.port !== 8080 ||
      !listensOnConfiguredLoopback) {
    throw new Error('Firebase Emulator connectivity could not be verified.')
  }

  return true
}

export async function verifyPerformanceApiBackend({
  target = PERFORMANCE_API_TARGET,
  fetchImpl = fetch,
  expectedRuntime,
} = {}) {
  if (expectedRuntime !== undefined &&
      !Object.values(PERFORMANCE_API_RUNTIME_IDS).includes(expectedRuntime)) {
    throw new Error('Expected performance API runtime is invalid.')
  }

  let response
  try {
    response = await fetchImpl(`${target}/api/test`, {
      signal: AbortSignal.timeout(3000),
    })
  } catch (error) {
    const cause = error?.cause
    const code = String(cause?.code || error?.code || '')
    const errorNames = `${error?.name || ''} ${cause?.name || ''}`
    const messages = `${error?.message || ''} ${cause?.message || ''}`
    const category = code === 'ECONNREFUSED'
      ? 'connection refused'
      : /TIMEOUT/i.test(code) || /Timeout|Abort/i.test(errorNames) || /timed out|timeout/i.test(messages)
        ? 'request timed out'
        : 'network request failed'
    const details = [
      formatFetchError(error),
      cause && `cause ${formatFetchError(cause)}`,
    ].filter(Boolean).join('; ')
    throw new Error(`Performance API backend ${category}: ${details}.`)
  }

  const { payload, summary } = await readBackendResponse(response)
  const status = Number.isInteger(response.status) ? response.status : 'unknown'
  const validIsolation = payload?.performanceMode === true &&
    payload?.projectId === PERFORMANCE_PROJECT_ID &&
    payload?.emulatorVerified === true

  if (!response.ok) {
    const statusText = ({ 404: 'Not Found', 500: 'Internal Server Error', 503: 'Service Unavailable' })[status]
    const safetyFlagsPresent = payload && (
      Object.prototype.hasOwnProperty.call(payload, 'performanceMode') ||
      Object.prototype.hasOwnProperty.call(payload, 'projectId') ||
      Object.prototype.hasOwnProperty.call(payload, 'emulatorVerified')
    )
    const isolationDetail = safetyFlagsPresent && !validIsolation
      ? '; emulator-isolation checks also failed'
      : ''
    throw new Error(
      `Performance API backend returned HTTP ${status}${statusText ? ` ${statusText}` : ''}${isolationDetail}. Sanitized response body: ${summary}`,
    )
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Performance API backend returned HTTP ${status} with an invalid JSON response. Sanitized response body: ${summary}`,
    )
  }

  if (!validIsolation) {
    throw new Error(
      `Performance API backend failed emulator-isolation checks (HTTP ${status}). Sanitized response body: ${summary}`,
    )
  }

  if (expectedRuntime) {
    const actualRuntime = response.headers?.get?.(PERFORMANCE_API_RUNTIME_HEADER)
    if (actualRuntime !== expectedRuntime) {
      throw new Error('Performance API backend runtime does not match the selected runtime.')
    }
    if (expectedRuntime === PERFORMANCE_API_RUNTIME_IDS.persistent) {
      const startupTime = response.headers?.get?.(PERFORMANCE_API_STARTUP_HEADER)
      if (typeof startupTime !== 'string' ||
          !/^\d+(?:\.\d+)?$/.test(startupTime) ||
          !Number.isFinite(Number(startupTime))) {
        throw new Error('Persistent performance API startup timing is unavailable.')
      }
    }
  }

  return true
}

export function sanitizePerformanceDiagnostic(value, maxLength = 400) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted token]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted key]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|api[\s_-]?key|credential|authorization|password|private[\s_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\b\+?\d[\d -]{7,}\d\b/g, '[redacted phone]')
    .slice(0, maxLength)
}

function formatFetchError(error) {
  const name = sanitizePerformanceDiagnostic(error?.name || error?.constructor?.name || 'Error', 60)
  const code = /^[A-Z0-9_-]+$/i.test(String(error?.code || ''))
    ? ` [${error.code}]`
    : ''
  const message = sanitizePerformanceDiagnostic(error?.message || 'Unknown fetch error', 240)
  return `${name}${code}: ${message}`
}

async function readBackendResponse(response) {
  let payload
  if (typeof response.text === 'function') {
    let text
    try {
      text = await response.text()
    } catch {
      return { payload: null, summary: '[response body unavailable]' }
    }

    if (!text.trim()) {
      return { payload: null, summary: '[empty response body]' }
    }
    try {
      payload = JSON.parse(text)
    } catch {
      return {
        payload: null,
        summary: `[non-JSON body omitted; ${text.length} characters]`,
      }
    }
  } else if (typeof response.json === 'function') {
    try {
      payload = await response.json()
    } catch {
      return { payload: null, summary: '[invalid JSON body]' }
    }
  } else {
    return { payload: null, summary: '[response body unavailable]' }
  }

  return { payload, summary: summarizeBackendPayload(payload) }
}

function summarizeBackendPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '{"body":"[fields omitted]"}'
  }

  const safe = {}
  for (const key of ['success', 'performanceMode', 'emulatorVerified']) {
    if (typeof payload[key] === 'boolean') safe[key] = payload[key]
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'projectId')) {
    safe.projectId = payload.projectId === PERFORMANCE_PROJECT_ID
      ? PERFORMANCE_PROJECT_ID
      : '[redacted]'
  }
  if (typeof payload.message === 'string') {
    safe.message = safePerformanceApiMessages.has(payload.message)
      ? payload.message
      : '[omitted]'
  }

  return JSON.stringify(Object.keys(safe).length ? safe : { body: '[fields omitted]' })
}

export async function verifyPerformanceWriteSafety({
  apiTarget = 'http://127.0.0.1:3001',
  fetchImpl = fetch,
} = {}) {
  await verifyFirestoreEmulator({ fetchImpl })
  await verifyPerformanceApiBackend({ target: apiTarget, fetchImpl })
  return true
}

export function createPerformanceWriteGuard({
  verify = verifyPerformanceWriteSafety,
} = {}) {
  return async function performanceWriteGuard(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next()
      return
    }

    try {
      await verify()
    } catch {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        success: false,
        message: 'Performance safety checks failed; no upload or write was sent.',
      }))
      return
    }

    next()
  }
}
