import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { sendError, setSecurityHeaders } from '../server/http.js'
import { getBestSellerProductIds } from '../server/bestSellers.js'
import {
  PERFORMANCE_AUTH_HOST,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_API_RUNTIME_HEADER,
  PERFORMANCE_PROJECT_ID,
  getPerformanceApiRuntimeIdentity,
} from '../server/performanceSafety.js'

const allowedTimingDescriptions = new Set(['hit', 'miss', 'in-flight'])

function isLocalPerformanceEnvironment(env) {
  return env.APP_MODE === 'performance' &&
    env.TELEGRAM_TEST_MODE === '1' &&
    env.FIREBASE_PROJECT_ID === PERFORMANCE_PROJECT_ID &&
    env.FIRESTORE_EMULATOR_HOST === PERFORMANCE_FIRESTORE_HOST &&
    env.FIREBASE_AUTH_EMULATOR_HOST === PERFORMANCE_AUTH_HOST &&
    env.NODE_ENV !== 'production' &&
    env.VERCEL_ENV !== 'production'
}

function setServerTimingHeader(res, timings, handlerStartedAt, handlerStartTime) {
  const entries = [`handler-entry;desc="${handlerStartedAt}"`]
  for (const timing of timings) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(timing.name) ||
        !Number.isFinite(timing.durationMs) ||
        timing.durationMs < 0) {
      continue
    }

    let entry = `${timing.name};dur=${timing.durationMs.toFixed(3)}`
    if (allowedTimingDescriptions.has(timing.description)) {
      entry += `;desc="${timing.description}"`
    }
    entries.push(entry)
  }
  entries.push(`handler-total;dur=${(performance.now() - handlerStartTime).toFixed(3)}`)
  res.setHeader('Server-Timing', entries.join(', '))
}

export default async function handler(req, res, {
  getProductIds = getBestSellerProductIds,
  env = process.env,
} = {}) {
  const handlerStartedAt = new Date().toISOString()
  const handlerStartTime = performance.now()
  setSecurityHeaders(res)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return sendError(res, 405, 'Method Not Allowed')
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
  const diagnosticsEnabled = isLocalPerformanceEnvironment(env)
  const runtimeIdentity = diagnosticsEnabled
    ? getPerformanceApiRuntimeIdentity(env)
    : null
  if (runtimeIdentity) {
    res.setHeader(PERFORMANCE_API_RUNTIME_HEADER, runtimeIdentity)
  }
  const timings = []
  try {
    const productIds = diagnosticsEnabled
      ? await getProductIds({ onTiming: (timing) => timings.push(timing) })
      : await getProductIds()
    if (diagnosticsEnabled) {
      setServerTimingHeader(res, timings, handlerStartedAt, handlerStartTime)
    }
    return res.status(200).json({ productIds })
  } catch (error) {
    console.error('[best-sellers] aggregation failed', error?.code || error?.message || 'unknown error')
    res.setHeader('Cache-Control', 'no-store')
    if (diagnosticsEnabled) {
      setServerTimingHeader(res, timings, handlerStartedAt, handlerStartTime)
    }
    return sendError(res, 500, 'Unable to load best sellers.')
  }
}
