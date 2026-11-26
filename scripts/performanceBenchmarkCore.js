import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

export const PERFORMANCE_FRONTEND_ORIGIN = 'http://127.0.0.1:5174'
export const PERFORMANCE_PREVIEW_ORIGIN = 'http://127.0.0.1:5175'
export const PERFORMANCE_CART_FIXTURE_ORIGINS = Object.freeze([
  PERFORMANCE_FRONTEND_ORIGIN,
  PERFORMANCE_PREVIEW_ORIGIN,
])
export const PERFORMANCE_API_ORIGIN = 'http://127.0.0.1:3001'
export const PERFORMANCE_API_PATH = '/api/best-sellers'
export const PERFORMANCE_API_URL = `${PERFORMANCE_API_ORIGIN}${PERFORMANCE_API_PATH}`
export const PERFORMANCE_FIRESTORE_ORIGIN = 'http://127.0.0.1:8080'
export const PERFORMANCE_AUTH_ORIGIN = 'http://127.0.0.1:9099'
export const PERFORMANCE_BENCHMARK_PAGES = Object.freeze([
  { id: 'home', path: '/' },
  { id: 'products', path: '/products' },
  { id: 'product-details', path: '/products/performance-seed-v1-001' },
  { id: 'cart', path: '/cart' },
])
export const PERFORMANCE_SMOKE_REQUESTS = 3
export const PERFORMANCE_DEFAULT_CONNECTIONS = 1
export const PERFORMANCE_DEFAULT_DURATION_SECONDS = 10
export const PERFORMANCE_MAX_CONNECTIONS = 5
export const PERFORMANCE_MAX_DURATION_SECONDS = 30

const benchmarkModes = new Set(['smoke', 'baseline', 'compare', 'load'])
const benchmarkApiRuntimes = new Set(['vercel', 'persistent'])
const permittedApiErrorTypes = new Set(['AbortError', 'TimeoutError', 'TypeError', 'Error'])
const permittedServerTimingNames = new Set([
  'handler-entry',
  'handler-total',
  'cache',
  'in_flight_wait',
  'recent_orders_query',
  'recent_aggregation',
  'recent_sales_ranking',
  'recent_product_reads',
  'recent_product_processing',
  'recent_product_ranking',
  'lifetime_fallback_query',
  'lifetime_aggregation',
  'lifetime_sales_ranking',
  'lifetime_product_reads',
  'lifetime_product_processing',
  'lifetime_product_ranking',
  'best_sellers_service',
])
const permittedTimingDescriptions = new Set(['hit', 'miss', 'in-flight'])
const firestoreListenPath = '/google.firestore.v1.Firestore/Listen/channel'
const authLookupPath = '/identitytoolkit.googleapis.com/v1/accounts:lookup'
const expectedFirestoreDatabase = 'projects/demo-gv-sarees/databases/(default)'
const permittedFrontendOrigins = new Set([
  PERFORMANCE_FRONTEND_ORIGIN,
  PERFORMANCE_PREVIEW_ORIGIN,
])
const permittedBrowserServiceOrigins = new Set([
  ...permittedFrontendOrigins,
  PERFORMANCE_API_ORIGIN,
  PERFORMANCE_FIRESTORE_ORIGIN,
  PERFORMANCE_AUTH_ORIGIN,
])

function assertContainedPath(root, candidate, label) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate)
  if (!pathFromRoot || pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} must be inside the performance report directory.`)
  }
  return resolvedCandidate
}

export function assertBenchmarkPageUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Benchmark page URL is invalid.')
  }

  if (!permittedFrontendOrigins.has(url.origin) ||
      !PERFORMANCE_BENCHMARK_PAGES.some((page) => page.path === url.pathname) ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('Benchmark page URL is outside the isolated performance allowlist.')
  }
  return url.href
}

export function assertReadOnlyApiUrl(value, method = 'GET') {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Benchmark API URL is invalid.')
  }

  if (method !== 'GET' ||
      url.origin !== PERFORMANCE_API_ORIGIN ||
      url.pathname !== PERFORMANCE_API_PATH ||
      url.search || url.hash || url.username || url.password) {
    throw new Error('Only GET /api/best-sellers on the isolated API is allowed for benchmarking.')
  }
  return url.href
}

function hasExpectedFirestoreDatabase(value) {
  if (typeof value !== 'string' || !value) return false

  let decodedValue = value.replace(/\+/g, ' ')
  try {
    for (let index = 0; index < 3; index += 1) {
      const decoded = decodeURIComponent(decodedValue)
      if (decoded === decodedValue) break
      decodedValue = decoded
    }
  } catch {
    return false
  }

  const projectIds = [...decodedValue.matchAll(/projects\/([^/"&?]+)/g)]
    .map((match) => match[1])
  const databaseIdentities = [...decodedValue.matchAll(
    /projects\/[^/"&?]+\/databases\/\([^)]+\)/g,
  )].map((match) => match[0])

  return projectIds.length > 0 &&
    projectIds.every((projectId) => projectId === 'demo-gv-sarees') &&
    databaseIdentities.length > 0 &&
    databaseIdentities.every((identity) => identity === expectedFirestoreDatabase)
}

function hasExpectedFirestoreDatabaseQuery(url) {
  const databaseValues = url.searchParams.getAll('database')
  if (databaseValues.length !== 1) return false

  let databaseIdentity = databaseValues[0]
  try {
    for (let index = 0; index < 3; index += 1) {
      const decoded = decodeURIComponent(databaseIdentity)
      if (decoded === databaseIdentity) break
      databaseIdentity = decoded
    }
  } catch {
    return false
  }

  return databaseIdentity === expectedFirestoreDatabase
}

export function sanitizeBrowserDiagnostic(value, maxLength = 1200) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted token]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted token]')
    .replace(/\b(?:rzp|sk|pk)_(?:live|test)_[A-Za-z0-9]+\b/gi, '[redacted key]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted signature]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|api[\s_-]?key|credential|authorization|password|private[\s_-]?key|razorpay[_\s-]?signature|payment[_\s-]?signature|signature)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/(?<!\w)\+?\d[\d -]{7,}\d\b/g, '[redacted phone]')
    .replace(/\b(name|address|email|phone|mobile|customer(?:[_\s-]?id)?|uid)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^,\n;]+)/gi, '$1=[redacted]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .slice(0, maxLength)
}

export function createBrowserErrorDiagnostic(page, type, error) {
  const diagnostic = {
    page,
    type,
    name: sanitizeBrowserDiagnostic(error?.name || 'Error', 80),
    message: sanitizeBrowserDiagnostic(error?.message || error, 500),
    stack: '',
  }
  if (type === 'pageerror') {
    diagnostic.stack = sanitizeBrowserDiagnostic(error?.stack || '', 1800)
  }
  return diagnostic
}

export function createBrowserRequestFailureDiagnostic({
  page,
  sample,
  method,
  url,
  errorText,
}) {
  let origin = '[invalid URL]'
  try {
    origin = new URL(url).origin
  } catch {
    // Keep malformed request URLs out of the report.
  }

  const safeMethod = browserRequestMethods.has(method) ? method : 'OTHER'
  const errorCode = /^net::([A-Z0-9_]{1,80})$/.exec(String(errorText || ''))

  return {
    page,
    sample,
    method: safeMethod,
    origin,
    failure: errorCode ? `net::${errorCode[1]}` : 'Request failed',
  }
}

const requiredBrowserMetricNames = Object.freeze([
  'pageLoadTimeMs',
  'domContentLoadedMs',
  'firstContentfulPaintMs',
  'largestContentfulPaintMs',
  'cumulativeLayoutShift',
])
const browserRequestMethods = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
])

export function collectBrowserTimingMetrics({
  navigation,
  paintEntries = [],
  pendingFirstContentfulPaintEntries = [],
  firstContentfulPaintMs,
  largestContentfulPaintMs,
  pendingLargestContentfulPaintEntries = [],
  cumulativeLayoutShift,
}) {
  const firstPaintEntry = paintEntries.find(
    (entry) => entry?.name === 'first-contentful-paint',
  )
  const pendingFirstContentfulPaintEntry = pendingFirstContentfulPaintEntries.find(
    (entry) => entry?.name === 'first-contentful-paint' &&
      Number.isFinite(entry.startTime),
  )
  const pendingLcpEntry = [...pendingLargestContentfulPaintEntries]
    .reverse()
    .find((entry) => Number.isFinite(entry?.startTime))

  return {
    pageLoadTimeMs: navigation?.loadEventEnd > 0
      ? navigation.loadEventEnd - navigation.startTime
      : null,
    domContentLoadedMs: navigation?.domContentLoadedEventEnd > 0
      ? navigation.domContentLoadedEventEnd - navigation.startTime
      : null,
    firstContentfulPaintMs: Number.isFinite(firstContentfulPaintMs)
      ? firstContentfulPaintMs
      : Number.isFinite(firstPaintEntry?.startTime)
        ? firstPaintEntry.startTime
        : Number.isFinite(pendingFirstContentfulPaintEntry?.startTime)
          ? pendingFirstContentfulPaintEntry.startTime
          : null,
    largestContentfulPaintMs: Number.isFinite(pendingLcpEntry?.startTime)
      ? pendingLcpEntry.startTime
      : Number.isFinite(largestContentfulPaintMs)
        ? largestContentfulPaintMs
        : null,
    cumulativeLayoutShift: Number.isFinite(cumulativeLayoutShift)
      ? cumulativeLayoutShift
      : null,
  }
}

export function getMissingBrowserMetricNames(metrics) {
  return requiredBrowserMetricNames.filter((name) => !Number.isFinite(metrics?.[name]))
}

export const BROWSER_PAINT_WAIT_MS = 1_000

export async function waitForBrowserPaintMetrics(page, timeoutMs = BROWSER_PAINT_WAIT_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Browser paint wait timeout must be a positive integer.')
  }

  try {
    await page.waitForFunction(
      () => {
        const vitals = globalThis.__gvPerformanceVitals
        return Number.isFinite(vitals?.firstContentfulPaintMs) &&
          Number.isFinite(vitals?.largestContentfulPaintMs)
      },
      null,
      { timeout: timeoutMs, polling: 'raf' },
    )
    return true
  } catch (error) {
    if (error?.name === 'TimeoutError') return false
    throw error
  }
}

const safeNavigationTypes = new Set(['navigate', 'reload', 'back_forward', 'prerender'])
const safeDocumentStates = new Set(['loading', 'interactive', 'complete'])
const safeVisibilityStates = new Set(['visible', 'hidden', 'prerender', 'unloaded'])
const safeObserverErrorNames = new Set([
  'Error',
  'NotSupportedError',
  'ObserverError',
  'SecurityError',
  'TypeError',
  'UnknownError',
])

function safeTimingNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function safeObserverEntries(entries, allowedNames) {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => (
    allowedNames.has(entry?.name) && Number.isFinite(entry.startTime) && entry.startTime >= 0
      ? [{ name: entry.name, startTime: entry.startTime }]
      : []
  ))
}

function safeObserverStatus(status = {}) {
  return {
    supported: status.supported === true,
    registered: status.registered === true,
    errorName: safeObserverErrorNames.has(status.errorName) ? status.errorName : null,
  }
}

export function createBrowserTimingDiagnostic({
  page,
  sample,
  missingMetrics = [],
  documentPath,
  readyState,
  visibilityState,
  navigation,
  paintEntries = [],
  paintObserver = {},
  lcpObserver = {},
  deliveredObserverEntries = {},
  pendingObserverRecords = {},
  paintWaitTimedOut,
}) {
  const knownPage = PERFORMANCE_BENCHMARK_PAGES.some((item) => item.id === page)
  const knownPath = PERFORMANCE_BENCHMARK_PAGES.some((item) => item.path === documentPath)
  const timingNames = [
    'startTime',
    'responseStart',
    'domInteractive',
    'domContentLoadedEventEnd',
    'loadEventEnd',
    'activationStart',
  ]
  const safeNavigation = navigation && typeof navigation === 'object'
    ? {
        type: safeNavigationTypes.has(navigation.type) ? navigation.type : 'unknown',
        timings: Object.fromEntries(timingNames.map((name) => [
          name,
          safeTimingNumber(navigation[name]),
        ])),
      }
    : null
  const paintNames = new Set(['first-paint', 'first-contentful-paint'])
  const lcpNames = new Set(['largest-contentful-paint'])

  return {
    page: knownPage ? page : 'unknown',
    sample: Number.isInteger(sample) && sample > 0 ? sample : null,
    missingMetrics: missingMetrics.filter((name) => requiredBrowserMetricNames.includes(name)),
    documentPath: knownPath ? documentPath : '[unrecognized path]',
    readyState: safeDocumentStates.has(readyState) ? readyState : 'unknown',
    visibilityState: safeVisibilityStates.has(visibilityState) ? visibilityState : 'unknown',
    navigation: safeNavigation,
    paintEntries: safeObserverEntries(paintEntries, paintNames),
    paintObserver: safeObserverStatus(paintObserver),
    lcpObserver: safeObserverStatus(lcpObserver),
    deliveredObserverEntries: {
      paint: safeObserverEntries(deliveredObserverEntries.paint, paintNames),
      largestContentfulPaint: safeObserverEntries(
        deliveredObserverEntries.largestContentfulPaint,
        lcpNames,
      ),
    },
    pendingObserverRecords: {
      paint: safeObserverEntries(pendingObserverRecords.paint, paintNames),
      largestContentfulPaint: safeObserverEntries(
        pendingObserverRecords.largestContentfulPaint,
        lcpNames,
      ),
    },
    paintWaitTimedOut: paintWaitTimedOut === true,
  }
}

export function parseServerTimingHeader(value) {
  if (typeof value !== 'string' || !value.trim()) return []

  return value.split(',').flatMap((rawEntry) => {
    const [rawName, ...parameters] = rawEntry.trim().split(';')
    const name = rawName?.trim()
    if (!permittedServerTimingNames.has(name)) return []

    let durationMs = null
    let description = null
    for (const rawParameter of parameters) {
      const parameter = rawParameter.trim()
      if (parameter.startsWith('dur=')) {
        const parsedDuration = Number(parameter.slice(4))
        if (Number.isFinite(parsedDuration) && parsedDuration >= 0) {
          durationMs = parsedDuration
        }
      } else if (parameter.startsWith('desc=')) {
        const parsedDescription = parameter.slice(5).replace(/^["']|["']$/g, '')
        if (permittedTimingDescriptions.has(parsedDescription) ||
            (name === 'handler-entry' &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(parsedDescription))) {
          description = parsedDescription
        }
      }
    }

    if (name !== 'handler-entry' && durationMs === null) return []
    return [{ name, durationMs, ...(description ? { description } : {}) }]
  })
}

export function createApiRequestTimingRecord({
  requestNumber,
  requestStartedAt,
  responseReceivedAt = null,
  requestEndedAt,
  requestStartMs,
  responseReceivedMs = null,
  requestEndMs,
  jsonParseValidationDurationMs = 0,
  httpStatusCode = null,
  payloadValid = false,
  serverTimingHeader = '',
  errorType = null,
}) {
  const requestStatus = errorType
    ? 'network_error'
    : httpStatusCode < 200 || httpStatusCode >= 300
      ? 'http_error'
      : payloadValid
        ? 'success'
        : 'invalid_payload'

  return {
    requestNumber,
    requestStartedAt,
    responseReceivedAt,
    requestEndedAt,
    responseDurationMs: Number.isFinite(responseReceivedMs)
      ? Math.max(0, responseReceivedMs - requestStartMs)
      : null,
    jsonParseValidationDurationMs: Math.max(0, Number(jsonParseValidationDurationMs) || 0),
    totalDurationMs: Math.max(0, requestEndMs - requestStartMs),
    httpStatusCode,
    requestStatus,
    serverTimings: parseServerTimingHeader(serverTimingHeader),
    ...(errorType ? { errorType: sanitizeBrowserDiagnostic(errorType, 60) } : {}),
  }
}

function getServiceCacheStatus(serverTimings) {
  const cacheTiming = serverTimings.find((timing) => timing.name === 'cache')
  return ['miss', 'hit', 'in-flight'].includes(cacheTiming?.description)
    ? cacheTiming.description
    : 'unavailable'
}

function getRuntimeStartupMs(response) {
  const rawValue = response.headers?.get?.('x-performance-runtime-startup-ms')
  if (typeof rawValue !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawValue)) return null
  const value = Number(rawValue)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function getApiSmokeFailureReason({
  fetchSucceeded,
  errorType,
  httpStatusCode,
  jsonParsingSucceeded,
  payloadValid,
  runtimeMatches,
  runtimeDiagnosticsValid,
}) {
  if (!fetchSucceeded) {
    const safeErrorType = permittedApiErrorTypes.has(errorType) ? errorType : 'Error'
    return `Fetch failed (${safeErrorType})`
  }
  if (!runtimeMatches) return 'Selected runtime does not match the responding API runtime'
  if (!runtimeDiagnosticsValid) return 'Persistent runtime startup timing is unavailable'
  if (!Number.isInteger(httpStatusCode)) return 'HTTP status unavailable'
  if (httpStatusCode < 200 || httpStatusCode >= 300) return `HTTP ${httpStatusCode}`
  if (!jsonParsingSucceeded) return 'Invalid JSON response'
  if (!payloadValid) return 'Invalid productIds payload'
  return null
}

export async function runApiSmokeRequests({
  url,
  requestCount,
  expectedRuntime,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  nowIso = () => new Date().toISOString(),
  createTimeoutSignal = () => AbortSignal.timeout(5000),
}) {
  assertReadOnlyApiUrl(url, 'GET')
  if (!Number.isInteger(requestCount) || requestCount < 1) {
    throw new Error('API smoke request count must be a positive integer.')
  }
  if (expectedRuntime !== undefined && !benchmarkApiRuntimes.has(expectedRuntime)) {
    throw new Error('Expected performance API runtime is invalid.')
  }

  const samples = []
  const requests = []
  let networkErrors = 0
  const startedAt = now()

  for (let index = 0; index < requestCount; index += 1) {
    const requestStartMs = now()
    const requestStartedAt = nowIso()
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: createTimeoutSignal(),
      })
    } catch (error) {
      networkErrors += 1
      const requestEndMs = now()
      const errorType = permittedApiErrorTypes.has(error?.name) ? error.name : 'Error'
      const record = createApiRequestTimingRecord({
        requestNumber: index + 1,
        requestStartedAt,
        requestEndedAt: nowIso(),
        requestStartMs,
        requestEndMs,
        errorType,
      })
      requests.push({
        ...record,
        fetchSucceeded: false,
        jsonParsingSucceeded: false,
        payloadValid: false,
        runtimeIdentity: null,
        runtimeStartupMs: null,
        runtimeMatches: expectedRuntime === undefined,
        runtimeDiagnosticsValid: expectedRuntime !== 'persistent',
        serviceCacheStatus: 'unavailable',
        cacheLatencyClass: 'unavailable',
        failureReason: getApiSmokeFailureReason({
          fetchSucceeded: false,
          errorType,
          runtimeMatches: expectedRuntime === undefined,
          runtimeDiagnosticsValid: expectedRuntime !== 'persistent',
        }),
      })
      continue
    }

    const responseReceivedMs = now()
    const responseReceivedAt = nowIso()
    const parseStartMs = now()
    let body
    let jsonParsingSucceeded = false
    try {
      body = await response.json()
      jsonParsingSucceeded = true
    } catch {
      body = null
    }
    const payloadValid = Boolean(
      jsonParsingSucceeded && body && Array.isArray(body.productIds),
    )
    const jsonParseValidationDurationMs = now() - parseStartMs
    const requestEndMs = now()
    const httpStatusCode = Number.isInteger(response.status) ? response.status : null
    const serverTimingHeader = response.headers?.get?.('server-timing') || ''
    const serverTimings = parseServerTimingHeader(serverTimingHeader)
    const runtimeIdentity = response.headers?.get?.('x-performance-api-runtime') || null
    const runtimeMatches = expectedRuntime === undefined ||
      runtimeIdentity === expectedRuntime
    const runtimeStartupMs = getRuntimeStartupMs(response)
    const runtimeDiagnosticsValid = expectedRuntime !== 'persistent' ||
      Number.isFinite(runtimeStartupMs)
    const serviceCacheStatus = getServiceCacheStatus(serverTimings)
    const cacheLatencyClass = serviceCacheStatus === 'miss'
      ? 'cold'
      : serviceCacheStatus === 'hit'
        ? 'warm'
        : serviceCacheStatus === 'in-flight'
          ? 'coalesced'
          : 'unavailable'
    const failureReason = getApiSmokeFailureReason({
      fetchSucceeded: true,
      httpStatusCode,
      jsonParsingSucceeded,
      payloadValid,
      runtimeMatches,
      runtimeDiagnosticsValid,
    })
    const record = createApiRequestTimingRecord({
      requestNumber: index + 1,
      requestStartedAt,
      responseReceivedAt,
      requestEndedAt: nowIso(),
      requestStartMs,
      responseReceivedMs,
      requestEndMs,
      jsonParseValidationDurationMs,
      httpStatusCode,
      payloadValid,
      serverTimingHeader,
    })
    requests.push({
      ...record,
      requestStatus: !runtimeMatches
        ? 'runtime_mismatch'
        : !runtimeDiagnosticsValid
          ? 'runtime_diagnostics_missing'
          : record.requestStatus,
      fetchSucceeded: true,
      jsonParsingSucceeded,
      payloadValid,
      runtimeIdentity,
      runtimeStartupMs,
      runtimeMatches,
      serviceCacheStatus,
      cacheLatencyClass,
      failureReason,
    })
    samples.push({
      latencyMs: record.totalDurationMs,
      statusCode: failureReason === null ? httpStatusCode : 500,
    })
  }

  return {
    metrics: summarizeSamples(samples, now() - startedAt, networkErrors),
    requests,
  }
}

export function persistApiSmokeResult(report, result, expectedRequestCount) {
  report.api.metrics = result.metrics
  report.api.requests = result.requests
  report.api.runtimeStartupMs = result.requests.find(
    (request) => Number.isFinite(request.runtimeStartupMs),
  )?.runtimeStartupMs ?? null
  const cacheGroups = {
    cold: result.requests.filter((request) => request.cacheLatencyClass === 'cold'),
    warm: result.requests.filter((request) => request.cacheLatencyClass === 'warm'),
    coalesced: result.requests.filter((request) => request.cacheLatencyClass === 'coalesced'),
    unavailable: result.requests.filter((request) => request.cacheLatencyClass === 'unavailable'),
  }
  report.api.cacheSummary = {
    coldServiceCacheRequests: cacheGroups.cold.length,
    actualCacheHitRequests: cacheGroups.warm.length,
    inFlightRequests: cacheGroups.coalesced.length,
    unclassifiedRequests: cacheGroups.unavailable.length,
    coldRequestLatencyMs: cacheGroups.cold.map((request) => request.totalDurationMs),
    warmRequestLatencyMs: cacheGroups.warm.map((request) => request.totalDurationMs),
  }
  return result.metrics.failedRequests === 0 &&
    result.metrics.totalRequests === expectedRequestCount
}

export function isAllowedBrowserRequest(value, method = 'GET', body = '') {
  if (value === 'about:blank' || value.startsWith('data:') || value.startsWith('blob:')) {
    return true
  }

  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }

  const origin = `${url.protocol === 'ws:' ? 'http:' : url.protocol}//${url.host}`
  if (!['http:', 'ws:'].includes(url.protocol) ||
      !permittedBrowserServiceOrigins.has(origin)) {
    return false
  }

  if (url.protocol === 'ws:') {
    return permittedFrontendOrigins.has(origin)
  }

  if (origin === PERFORMANCE_API_ORIGIN) {
    return ['GET', 'HEAD'].includes(method) &&
      ['/api/test', PERFORMANCE_API_PATH].includes(url.pathname)
  }

  if (permittedFrontendOrigins.has(origin)) {
    if (!['GET', 'HEAD'].includes(method)) return false
    return !url.pathname.startsWith('/api/') ||
      ['/api/test', PERFORMANCE_API_PATH].includes(url.pathname)
  }

  if (origin === PERFORMANCE_FIRESTORE_ORIGIN) {
    if (url.pathname === firestoreListenPath) {
      if (method === 'POST') {
        return hasExpectedFirestoreDatabase(`${url.pathname}${url.search}\n${body}`)
      }
      return method === 'GET' && hasExpectedFirestoreDatabaseQuery(url)
    }
    if (url.pathname.startsWith('/google.firestore.v1.Firestore/Listen/')) {
      return false
    }

    const requestTarget = `${url.pathname}${url.search}`
    if (!hasExpectedFirestoreDatabase(requestTarget)) return false
    if (['GET', 'HEAD'].includes(method)) return true
    return method === 'POST' && (
      url.pathname.endsWith('/documents:runQuery') ||
      url.pathname.endsWith('/Firestore/RunQuery') ||
      url.pathname.endsWith('/Firestore/BatchGetDocuments')
    )
  }

  return origin === PERFORMANCE_AUTH_ORIGIN &&
    method === 'POST' &&
    url.pathname === authLookupPath
}

export function parseBenchmarkOptions(argv = []) {
  const options = {
    mode: 'smoke',
    apiRuntime: 'vercel',
    connections: PERFORMANCE_DEFAULT_CONNECTIONS,
    durationSeconds: PERFORMANCE_DEFAULT_DURATION_SECONDS,
    baselineFile: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--mode') {
      options.mode = argv[++index]
    } else if (argument === '--api-runtime') {
      options.apiRuntime = argv[++index]
    } else if (argument === '--connections') {
      options.connections = Number(argv[++index])
    } else if (argument === '--duration-seconds') {
      options.durationSeconds = Number(argv[++index])
    } else if (argument === '--baseline-file') {
      options.baselineFile = argv[++index]
    } else if (argument === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown benchmark option: ${argument}`)
    }
  }

  if (options.help) return options
  if (!benchmarkModes.has(options.mode)) {
    throw new Error('Benchmark mode must be smoke, baseline, compare, or load.')
  }
  if (!benchmarkApiRuntimes.has(options.apiRuntime)) {
    throw new Error('Benchmark API runtime must be vercel or persistent.')
  }
  if (!Number.isInteger(options.connections) ||
      options.connections < 1 ||
      options.connections > PERFORMANCE_MAX_CONNECTIONS) {
    throw new Error(`Benchmark connections must be between 1 and ${PERFORMANCE_MAX_CONNECTIONS}.`)
  }
  if (!Number.isInteger(options.durationSeconds) ||
      options.durationSeconds < 1 ||
      options.durationSeconds > PERFORMANCE_MAX_DURATION_SECONDS) {
    throw new Error(`Benchmark duration must be between 1 and ${PERFORMANCE_MAX_DURATION_SECONDS} seconds.`)
  }

  return options
}

export function summarizeSamples(samples, elapsedMs, networkErrors = 0) {
  const latencies = samples
    .map((sample) => Number(sample.latencyMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right)
  const badResponses = samples.filter((sample) => (
    !Number.isInteger(sample.statusCode) ||
    sample.statusCode < 200 ||
    sample.statusCode >= 300
  )).length
  const totalRequests = samples.length + Math.max(0, networkErrors)
  const successfulRequests = Math.max(0, totalRequests - badResponses - Math.max(0, networkErrors))
  const percentile = (fraction) => latencies.length
    ? latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)]
    : null
  const median = latencies.length
    ? latencies.length % 2
      ? latencies[Math.floor(latencies.length / 2)]
      : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2
    : null

  return {
    totalRequests,
    successfulRequests,
    failedRequests: badResponses + Math.max(0, networkErrors),
    averageLatencyMs: latencies.length
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
      : null,
    medianLatencyMs: median,
    p95LatencyMs: percentile(0.95),
    p99LatencyMs: percentile(0.99),
    requestsPerSecond: elapsedMs > 0 ? totalRequests / (elapsedMs / 1000) : null,
    errorRate: totalRequests > 0
      ? (badResponses + Math.max(0, networkErrors)) / totalRequests
      : 0,
    elapsedMs,
  }
}

export function aggregatePageSamples(samples) {
  const metricNames = [
    'pageLoadTimeMs',
    'domContentLoadedMs',
    'firstContentfulPaintMs',
    'largestContentfulPaintMs',
    'cumulativeLayoutShift',
  ]
  const metrics = {}
  for (const name of metricNames) {
    const values = samples
      .map((sample) => sample[name])
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right)
    metrics[name] = values.length
      ? {
          average: values.reduce((sum, value) => sum + value, 0) / values.length,
          median: values.length % 2
            ? values[Math.floor(values.length / 2)]
            : (values[values.length / 2 - 1] + values[values.length / 2]) / 2,
          p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)],
          p99: values[Math.max(0, Math.ceil(values.length * 0.99) - 1)],
        }
      : null
  }
  return metrics
}

export function compareBenchmarkResults(current, baseline) {
  if (baseline?.schemaVersion !== 1 ||
      current?.schemaVersion !== 1 ||
      JSON.stringify(current.settings) !== JSON.stringify(baseline.settings)) {
    throw new Error('The selected baseline is incompatible with this benchmark run.')
  }

  const comparison = []
  const metricPairs = []
  for (const currentPage of current.browser?.pages || []) {
    const baselinePage = baseline.browser?.pages?.find((page) => page.id === currentPage.id)
    if (!baselinePage) continue
    for (const metricName of [
      'pageLoadTimeMs',
      'domContentLoadedMs',
      'firstContentfulPaintMs',
      'largestContentfulPaintMs',
      'cumulativeLayoutShift',
    ]) {
      metricPairs.push({
        section: currentPage.id,
        metric: metricName,
        baseline: baselinePage.metrics?.[metricName]?.median ?? null,
        current: currentPage.metrics?.[metricName]?.median ?? null,
      })
    }
  }

  const currentApi = current.api?.metrics
  const baselineApi = baseline.api?.metrics
  for (const metricName of [
    'averageLatencyMs',
    'medianLatencyMs',
    'p95LatencyMs',
    'p99LatencyMs',
    'requestsPerSecond',
    'errorRate',
  ]) {
    metricPairs.push({
      section: 'best-sellers-api',
      metric: metricName,
      baseline: baselineApi?.[metricName] ?? null,
      current: currentApi?.[metricName] ?? null,
    })
  }

  for (const currentAudit of current.lighthouse || []) {
    const baselineAudit = baseline.lighthouse?.find((audit) => audit.id === currentAudit.id)
    if (!baselineAudit) continue
    for (const metricName of [
      'performanceScore',
      'firstContentfulPaintMs',
      'largestContentfulPaintMs',
      'cumulativeLayoutShift',
    ]) {
      metricPairs.push({
        section: `lighthouse-${currentAudit.id}`,
        metric: metricName,
        baseline: baselineAudit.metrics?.[metricName] ?? null,
        current: currentAudit.metrics?.[metricName] ?? null,
      })
    }
  }

  for (const pair of metricPairs) {
    const baselineValue = pair.baseline
    const currentValue = pair.current
    comparison.push({
      ...pair,
      delta: Number.isFinite(currentValue) && Number.isFinite(baselineValue)
        ? currentValue - baselineValue
        : null,
      percentChange: Number.isFinite(currentValue) &&
        Number.isFinite(baselineValue) &&
        baselineValue !== 0
        ? ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100
        : null,
    })
  }

  return comparison
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function displayNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a'
}

function metricRows(report) {
  const rows = []
  for (const page of report.browser?.pages || []) {
    for (const [metricName, metric] of Object.entries(page.metrics || {})) {
      rows.push(
        `<tr><td>${escapeHtml(page.id)}</td><td>${escapeHtml(metricName)}</td>` +
        `<td>${displayNumber(metric?.median)}</td><td>${displayNumber(metric?.p95)}</td></tr>`,
      )
    }
  }
  for (const audit of report.lighthouse || []) {
    for (const [metricName, value] of Object.entries(audit.metrics || {})) {
      rows.push(
        `<tr><td>Lighthouse ${escapeHtml(audit.id)}</td><td>${escapeHtml(metricName)}</td>` +
        `<td>${displayNumber(value)}</td><td>n/a</td></tr>`,
      )
    }
  }
  for (const [metricName, value] of Object.entries(report.api?.metrics || {})) {
    rows.push(
      `<tr><td>Best sellers API</td><td>${escapeHtml(metricName)}</td>` +
      `<td>${displayNumber(value)}</td><td>n/a</td></tr>`,
    )
  }
  return rows.join('\n')
}

function comparisonRows(comparison = []) {
  return (comparison || []).map((item) => (
    `<tr><td>${escapeHtml(item.section)}</td><td>${escapeHtml(item.metric)}</td>` +
    `<td>${displayNumber(item.baseline)}</td><td>${displayNumber(item.current)}</td>` +
    `<td>${displayNumber(item.delta)}</td><td>${displayNumber(item.percentChange)}%</td></tr>`
  )).join('\n')
}

function apiRequestTimingRows(requests = []) {
  return requests.map((request) => (
    `<tr><td>${displayNumber(request.requestNumber, 0)}</td>` +
    `<td>${escapeHtml(request.requestStartedAt)}</td><td>${escapeHtml(request.requestEndedAt)}</td>` +
    `<td>${displayNumber(request.responseDurationMs)}</td>` +
    `<td>${displayNumber(request.jsonParseValidationDurationMs)}</td>` +
    `<td>${displayNumber(request.totalDurationMs)}</td>` +
    `<td>${escapeHtml(request.httpStatusCode ?? 'n/a')}</td>` +
    `<td>${request.fetchSucceeded ? 'yes' : 'no'}</td>` +
    `<td>${request.jsonParsingSucceeded ? 'yes' : 'no'}</td>` +
    `<td>${request.payloadValid ? 'yes' : 'no'}</td>` +
    `<td>${escapeHtml(request.runtimeIdentity || 'unverified')}</td>` +
    `<td>${displayNumber(request.runtimeStartupMs)}</td>` +
    `<td>${escapeHtml(request.serviceCacheStatus || 'unavailable')}</td>` +
    `<td>${escapeHtml(request.cacheLatencyClass || 'unavailable')}</td>` +
    `<td>${escapeHtml(request.failureReason || '')}</td>` +
    `<td>${escapeHtml(request.requestStatus)}</td></tr>`
  )).join('\n')
}

function serverTimingRows(requests = []) {
  return requests.flatMap((request) => (request.serverTimings || []).map((timing) => (
    `<tr><td>${displayNumber(request.requestNumber, 0)}</td>` +
    `<td>${escapeHtml(timing.name)}</td><td>${displayNumber(timing.durationMs)}</td>` +
    `<td>${escapeHtml(timing.description || '')}</td></tr>`
  ))).join('\n')
}

export function renderBenchmarkHtml(report) {
  const blockedOrigins = (report.blockedExternalOrigins || [])
    .map((origin) => `<li>${escapeHtml(origin)}</li>`)
    .join('')
  const blockedEmulatorOrigins = (report.blockedLocalEmulatorOrigins || [])
    .map((origin) => `<li>${escapeHtml(origin)}</li>`)
    .join('')
  const blockedLocalOrigins = (report.blockedLocalServiceOrigins || [])
    .map((origin) => `<li>${escapeHtml(origin)}</li>`)
    .join('')
  const errors = (report.errors || [])
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join('')
  const browserErrors = (report.browser?.errors || [])
    .map((error) => (
      `<li><strong>${escapeHtml(error.page)} · ${escapeHtml(error.type)} · ${escapeHtml(error.name)}</strong>` +
      `<pre>${escapeHtml(`${error.message}\n${error.stack || ''}`)}</pre></li>`
    ))
    .join('')
  const failedBrowserRequests = (report.browser?.failedRequests || [])
    .map((request) => (
      `<li>${escapeHtml(request.page)} sample ${escapeHtml(request.sample)} · ` +
      `${escapeHtml(request.method)} ${escapeHtml(request.origin)} · ` +
      `${escapeHtml(request.failure)}</li>`
    ))
    .join('')
  const missingBrowserMetrics = (report.browser?.missingMetrics || [])
    .map((item) => (
      `<li>${escapeHtml(item.page)} sample ${escapeHtml(item.sample)} · ` +
      `${escapeHtml((item.metrics || []).join(', '))}</li>`
    ))
    .join('')
  const browserTimingDiagnostics = (report.browser?.timingDiagnostics || [])
    .map((diagnostic) => (
      `<li><strong>${escapeHtml(diagnostic.page)} sample ${escapeHtml(diagnostic.sample)}</strong>` +
      `<pre>${escapeHtml(JSON.stringify(diagnostic, null, 2))}</pre></li>`
    ))
    .join('')
  const comparisons = comparisonRows(report.comparison)
  const apiRequests = report.api?.requests || []
  const apiTimings = serverTimingRows(apiRequests)
  const cacheSummary = report.api?.cacheSummary

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GV Sarees performance benchmark</title>
  <style>
    body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#28212a}
    h1,h2{color:#5c273d}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}
    th,td{border:1px solid #e6d9df;padding:.55rem;text-align:left}th{background:#f8f0f3}
    pre{white-space:pre-wrap;overflow-wrap:anywhere}
    .status{font-weight:700}.blocked{color:#7a4c00}.errors{color:#9e1d35}
  </style>
</head>
<body>
  <h1>GV Sarees performance benchmark</h1>
  <p>Run: <strong>${escapeHtml(report.runId)}</strong> · Mode: <strong>${escapeHtml(report.mode)}</strong> · Status: <span class="status">${escapeHtml(report.status)}</span></p>
  <p>Timestamp: ${escapeHtml(report.timestamp)} · Project: ${escapeHtml(report.projectId || 'unverified')}</p>
  <h2>Metrics</h2>
  <table><thead><tr><th>Target</th><th>Metric</th><th>Median/value</th><th>P95</th></tr></thead><tbody>
    ${metricRows(report)}
  </tbody></table>
  ${report.api ? `<h2>API runtime diagnostics</h2>
  <p>Selected runtime: <strong>${escapeHtml(report.settings?.apiRuntime || 'unspecified')}</strong> · Process startup/import: <strong>${displayNumber(report.api.runtimeStartupMs)} ms</strong></p>
  ${cacheSummary ? `<table><thead><tr><th>Cache category</th><th>Requests</th><th>Request durations (ms)</th></tr></thead><tbody>
    <tr><td>Cold service-cache misses</td><td>${displayNumber(cacheSummary.coldServiceCacheRequests, 0)}</td><td>${escapeHtml((cacheSummary.coldRequestLatencyMs || []).map((value) => displayNumber(value)).join(', ') || 'n/a')}</td></tr>
    <tr><td>Actual cache hits</td><td>${displayNumber(cacheSummary.actualCacheHitRequests, 0)}</td><td>${escapeHtml((cacheSummary.warmRequestLatencyMs || []).map((value) => displayNumber(value)).join(', ') || 'n/a')}</td></tr>
    <tr><td>In-flight reuse</td><td>${displayNumber(cacheSummary.inFlightRequests, 0)}</td><td>n/a</td></tr>
    <tr><td>Unclassified</td><td>${displayNumber(cacheSummary.unclassifiedRequests, 0)}</td><td>n/a</td></tr>
  </tbody></table>` : ''}` : ''}
  ${apiRequests.length ? `<h2>Best sellers API request timings</h2>
  <table><thead><tr><th>Request</th><th>Start</th><th>End</th><th>HTTP response (ms)</th><th>JSON and validation (ms)</th><th>Total (ms)</th><th>HTTP status</th><th>Fetch succeeded</th><th>JSON parsed</th><th>Valid payload</th><th>Runtime identity</th><th>Runtime startup (ms)</th><th>Cache status</th><th>Cache class</th><th>Failure reason</th><th>Result</th></tr></thead><tbody>${apiRequestTimingRows(apiRequests)}</tbody></table>` : ''}
  ${apiTimings ? `<h2>Best sellers API server timings</h2>
  <table><thead><tr><th>Request</th><th>Stage</th><th>Duration (ms)</th><th>Description</th></tr></thead><tbody>${apiTimings}</tbody></table>` : ''}
  ${comparisons ? `<h2>Baseline comparison</h2><table><thead><tr><th>Target</th><th>Metric</th><th>Baseline</th><th>Current</th><th>Delta</th><th>Change</th></tr></thead><tbody>${comparisons}</tbody></table>` : ''}
  ${blockedOrigins ? `<h2 class="blocked">Blocked external origins</h2><ul>${blockedOrigins}</ul>` : ''}
  ${blockedEmulatorOrigins ? `<h2 class="blocked">Blocked local emulator origins</h2><ul>${blockedEmulatorOrigins}</ul>` : ''}
  ${blockedLocalOrigins ? `<h2 class="blocked">Blocked local service origins</h2><ul>${blockedLocalOrigins}</ul>` : ''}
  ${browserErrors ? `<h2 class="errors">Browser errors</h2><ul>${browserErrors}</ul>` : ''}
  ${failedBrowserRequests ? `<h2 class="errors">Failed local browser requests</h2><ul>${failedBrowserRequests}</ul>` : ''}
  ${missingBrowserMetrics ? `<h2 class="errors">Missing browser timing metrics</h2><ul>${missingBrowserMetrics}</ul>` : ''}
  ${browserTimingDiagnostics ? `<h2 class="errors">Browser timing diagnostics</h2><ul>${browserTimingDiagnostics}</ul>` : ''}
  ${errors ? `<h2 class="errors">Errors</h2><ul>${errors}</ul>` : ''}
  <p>All benchmark requests are limited to local performance services and read-only API calls.</p>
</body>
</html>`
}

export function createRunId(date = new Date()) {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
}

export function resolvePerformanceReportPath(root, candidate) {
  const reportRoot = resolve(root, '.performance-reports')
  const resolvedCandidate = resolve(root, candidate)
  return assertContainedPath(reportRoot, resolvedCandidate, 'Performance report path')
}

export async function writeBenchmarkReports({
  root,
  runId,
  report,
  baselineFile = '.performance-reports/baseline.json',
  writeBaseline = false,
}) {
  if (!/^[A-Za-z0-9T-Z_-]+$/.test(runId)) {
    throw new Error('Performance report run ID is invalid.')
  }

  const reportRoot = resolve(root, '.performance-reports')
  const reportDirectory = assertContainedPath(reportRoot, resolve(reportRoot, runId), 'Performance report directory')
  const resolvedBaseline = resolvePerformanceReportPath(root, baselineFile)
  await mkdir(reportRoot, { recursive: true })
  await mkdir(reportDirectory, { recursive: false })

  const jsonPath = resolve(reportDirectory, 'report.json')
  const htmlPath = resolve(reportDirectory, 'report.html')
  const json = `${JSON.stringify(report, null, 2)}\n`
  await Promise.all([
    writeFile(jsonPath, json, 'utf8'),
    writeFile(htmlPath, renderBenchmarkHtml(report), 'utf8'),
  ])
  if (writeBaseline) {
    await writeFile(resolvedBaseline, json, 'utf8')
  }

  return { reportDirectory, jsonPath, htmlPath, baselinePath: writeBaseline ? resolvedBaseline : null }
}
