import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApiProxyConfig } from '../server/apiProxyConfig.js'
import {
  PERFORMANCE_API_URL,
  PERFORMANCE_AUTH_ORIGIN,
  PERFORMANCE_FIRESTORE_ORIGIN,
  PERFORMANCE_FRONTEND_ORIGIN,
  PERFORMANCE_PREVIEW_ORIGIN,
  PERFORMANCE_CART_FIXTURE_ORIGINS,
  BROWSER_PAINT_WAIT_MS,
  aggregatePageSamples,
  assertBenchmarkPageUrl,
  assertReadOnlyApiUrl,
  collectBrowserTimingMetrics,
  compareBenchmarkResults,
  createApiRequestTimingRecord,
  createBrowserErrorDiagnostic,
  createBrowserRequestFailureDiagnostic,
  createBrowserTimingDiagnostic,
  escapeHtml,
  getMissingBrowserMetricNames,
  isAllowedBrowserRequest,
  parseBenchmarkOptions,
  parseServerTimingHeader,
  persistApiSmokeResult,
  renderBenchmarkHtml,
  resolvePerformanceReportPath,
  runApiSmokeRequests,
  sanitizeBrowserDiagnostic,
  summarizeSamples,
  waitForBrowserPaintMetrics,
  writeBenchmarkReports,
} from '../scripts/performanceBenchmarkCore.js'

test('benchmark page URLs are restricted to the four local storefront routes', () => {
  assert.equal(
    assertBenchmarkPageUrl(`${PERFORMANCE_FRONTEND_ORIGIN}/products`),
    `${PERFORMANCE_FRONTEND_ORIGIN}/products`,
  )
  assert.equal(
    assertBenchmarkPageUrl(`${PERFORMANCE_PREVIEW_ORIGIN}/products/performance-seed-v1-001`),
    `${PERFORMANCE_PREVIEW_ORIGIN}/products/performance-seed-v1-001`,
  )
  for (const url of [
    'https://example.com/products',
    'http://127.0.0.1:5173/products',
    `${PERFORMANCE_FRONTEND_ORIGIN}/admin`,
    `${PERFORMANCE_FRONTEND_ORIGIN}/products?sort=price`,
  ]) {
    assert.throws(() => assertBenchmarkPageUrl(url), /outside the isolated performance allowlist/)
  }
})

test('only GET requests to the local best-sellers API are benchmarkable', () => {
  assert.equal(assertReadOnlyApiUrl(PERFORMANCE_API_URL), PERFORMANCE_API_URL)
  assert.throws(() => assertReadOnlyApiUrl(PERFORMANCE_API_URL, 'POST'), /Only GET/)
  assert.throws(
    () => assertReadOnlyApiUrl(`${PERFORMANCE_API_URL}/../reservations/create`),
    /Only GET/,
  )
  assert.throws(
    () => assertReadOnlyApiUrl('https://api.example.com/api/best-sellers'),
    /Only GET/,
  )
})

test('browser traffic stays on loopback and blocks API mutations and external origins', () => {
  assert.equal(isAllowedBrowserRequest(`${PERFORMANCE_FRONTEND_ORIGIN}/products`, 'GET'), true)
  assert.equal(isAllowedBrowserRequest(`${PERFORMANCE_FRONTEND_ORIGIN}/api/best-sellers`, 'GET'), true)
  assert.equal(isAllowedBrowserRequest(`${PERFORMANCE_FRONTEND_ORIGIN}/api/reservations/create`, 'POST'), false)
  assert.equal(isAllowedBrowserRequest(`${PERFORMANCE_API_URL}`, 'POST'), false)
  assert.equal(isAllowedBrowserRequest('https://api.telegram.org/botTOKEN/sendMessage', 'POST'), false)
  assert.equal(isAllowedBrowserRequest('https://fonts.googleapis.com/css?family=Roboto', 'GET'), false)
  assert.equal(isAllowedBrowserRequest('https://www.google.com/', 'GET'), false)
  assert.equal(isAllowedBrowserRequest('https://identitytoolkit.googleapis.com/v1/accounts:lookup', 'POST'), false)
  assert.equal(isAllowedBrowserRequest('ws://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel'), false)
})

test('Firestore emulator allows demo-project reads and validated Listen POST/GET requests', () => {
  const listenUrl = `${PERFORMANCE_FIRESTORE_ORIGIN}/google.firestore.v1.Firestore/Listen/channel`
  const demoDatabase = 'projects/demo-gv-sarees/databases/(default)'
  const listenBody = `database=${encodeURIComponent(demoDatabase)}`
  const listenGetUrl = `${listenUrl}?database=${encodeURIComponent(demoDatabase)}`
  const wrongProjectBody = `database=${encodeURIComponent('projects/production-project/databases/(default)')}`
  const wrongDatabaseBody = `database=${encodeURIComponent('projects/demo-gv-sarees/databases/other')}`
  const wrongProjectGetUrl = `${listenUrl}?database=${encodeURIComponent('projects/production-project/databases/(default)')}`
  const wrongDatabaseGetUrl = `${listenUrl}?database=${encodeURIComponent('projects/demo-gv-sarees/databases/other')}`

  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_FIRESTORE_ORIGIN}/v1/projects/demo-gv-sarees/databases/(default)/documents:runQuery`,
      'POST',
    ),
    true,
  )
  assert.equal(
    isAllowedBrowserRequest(listenUrl, 'POST', listenBody),
    true,
  )
  assert.equal(isAllowedBrowserRequest(listenGetUrl, 'GET'), true)
  assert.equal(isAllowedBrowserRequest(listenUrl, 'POST', wrongProjectBody), false)
  assert.equal(isAllowedBrowserRequest(listenUrl, 'POST', wrongDatabaseBody), false)
  assert.equal(isAllowedBrowserRequest(wrongProjectGetUrl, 'GET'), false)
  assert.equal(isAllowedBrowserRequest(wrongDatabaseGetUrl, 'GET'), false)
  assert.equal(
    isAllowedBrowserRequest(
      `${listenUrl}?database=${encodeURIComponent('projects/production-project/databases/(default)')}`,
      'POST',
      listenBody,
    ),
    false,
  )
  assert.equal(isAllowedBrowserRequest(listenUrl, 'GET', listenBody), false)
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_FIRESTORE_ORIGIN}/google.firestore.v1.Firestore/Listen/other?database=${encodeURIComponent(demoDatabase)}`,
      'GET',
    ),
    false,
  )
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_FIRESTORE_ORIGIN}/v1/projects/production-project/databases/(default)/documents:runQuery`,
      'POST',
    ),
    false,
  )
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_FIRESTORE_ORIGIN}/v1/projects/demo-gv-sarees/databases/(default)/documents:commit`,
      'POST',
    ),
    false,
  )
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_FIRESTORE_ORIGIN}/v1/projects/demo-gv-sarees/databases/(default)/documents`,
      'DELETE',
    ),
    false,
  )
})

test('Firebase Auth allows only the local read-only account lookup route', () => {
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=redacted`,
      'POST',
    ),
    true,
  )
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`,
      'POST',
    ),
    false,
  )
  assert.equal(
    isAllowedBrowserRequest(
      `${PERFORMANCE_AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:lookup`,
      'GET',
    ),
    false,
  )
})

test('browser error diagnostics retain useful stacks while redacting sensitive data', () => {
  const apiKey = `AIza${'A'.repeat(32)}`
  const token = `eyJ${'a'.repeat(14)}.${'b'.repeat(14)}.${'c'.repeat(14)}`
  const signature = 'a'.repeat(64)
  const diagnostic = createBrowserErrorDiagnostic('home', 'pageerror', {
    name: 'TypeError',
    message: `Failed for email=customer@example.test phone=+1 555 123 4567 razorpay_signature=${signature}`,
    stack: `TypeError at render\n at load (https://example.test/app.js?key=${apiKey})\n Bearer ${token}`,
  })

  assert.equal(diagnostic.page, 'home')
  assert.equal(diagnostic.type, 'pageerror')
  assert.equal(diagnostic.name, 'TypeError')
  assert.match(diagnostic.message, /Failed for/)
  assert.match(diagnostic.stack, /at render/)
  assert.match(diagnostic.stack, /\[redacted URL\]/)
  for (const secret of [apiKey, token, signature, 'customer@example.test', '+1 555 123 4567']) {
    assert.equal(diagnostic.message.includes(secret) || diagnostic.stack.includes(secret), false)
  }
  assert.equal(sanitizeBrowserDiagnostic('signature=do-not-log'), 'signature=[redacted]')
})

test('browser timing collection includes queued LCP records delivered after the first snapshot', () => {
  const metrics = collectBrowserTimingMetrics({
    navigation: {
      startTime: 0,
      domContentLoadedEventEnd: 80,
      loadEventEnd: 120,
    },
    paintEntries: [{ name: 'first-contentful-paint', startTime: 50 }],
    firstContentfulPaintMs: 50,
    largestContentfulPaintMs: null,
    pendingLargestContentfulPaintEntries: [{ startTime: 175 }],
    cumulativeLayoutShift: 0,
  })

  assert.equal(metrics.largestContentfulPaintMs, 175)
  assert.deepEqual(getMissingBrowserMetricNames(metrics), [])
})

test('browser timing validation names missing metrics without substituting values', () => {
  const metrics = collectBrowserTimingMetrics({
    navigation: {
      startTime: 0,
      domContentLoadedEventEnd: 80,
      loadEventEnd: 120,
    },
    paintEntries: [{ name: 'first-contentful-paint', startTime: 50 }],
    firstContentfulPaintMs: 50,
    largestContentfulPaintMs: null,
    pendingLargestContentfulPaintEntries: [],
    cumulativeLayoutShift: 0,
  })

  assert.equal(metrics.largestContentfulPaintMs, null)
  assert.deepEqual(getMissingBrowserMetricNames(metrics), ['largestContentfulPaintMs'])
})

test('browser timing metrics accept actual pending FCP observer records', () => {
  const metrics = collectBrowserTimingMetrics({
    navigation: {
      startTime: 0,
      domContentLoadedEventEnd: 80,
      loadEventEnd: 120,
    },
    pendingFirstContentfulPaintEntries: [{
      name: 'first-contentful-paint',
      startTime: 50,
    }],
    largestContentfulPaintMs: 175,
    cumulativeLayoutShift: 0,
  })

  assert.equal(metrics.firstContentfulPaintMs, 50)
  assert.deepEqual(getMissingBrowserMetricNames(metrics), [])
})

test('browser paint wait observes actual metrics and returns false at its bounded timeout', async () => {
  const previousVitals = globalThis.__gvPerformanceVitals
  globalThis.__gvPerformanceVitals = {
    firstContentfulPaintMs: 50,
    largestContentfulPaintMs: 75,
  }
  try {
    let successOptions
    const successfulPage = {
      async waitForFunction(predicate, argument, options) {
        successOptions = options
        assert.equal(argument, null)
        assert.equal(predicate(), true)
      },
    }

    assert.equal(await waitForBrowserPaintMetrics(successfulPage), true)
    assert.deepEqual(successOptions, {
      timeout: BROWSER_PAINT_WAIT_MS,
      polling: 'raf',
    })

    let timeoutOptions
    const timeoutPage = {
      async waitForFunction(predicate, argument, options) {
        timeoutOptions = options
        assert.equal(predicate(), true)
        const error = new Error('bounded wait expired')
        error.name = 'TimeoutError'
        throw error
      },
    }
    assert.equal(await waitForBrowserPaintMetrics(timeoutPage, 250), false)
    assert.equal(timeoutOptions.timeout, 250)

    const failedPage = {
      async waitForFunction() {
        throw new Error('unexpected page failure')
      },
    }
    await assert.rejects(
      waitForBrowserPaintMetrics(failedPage),
      /unexpected page failure/,
    )
  } finally {
    if (previousVitals === undefined) {
      delete globalThis.__gvPerformanceVitals
    } else {
      globalThis.__gvPerformanceVitals = previousVitals
    }
  }
})

test('browser timing diagnostics retain only sanitized timing and observer fields', () => {
  const secret = `123456:${'s'.repeat(32)}`
  const diagnostic = createBrowserTimingDiagnostic({
    page: 'products',
    sample: 1,
    missingMetrics: ['firstContentfulPaintMs', 'largestContentfulPaintMs', 'secret'],
    documentPath: '/products',
    readyState: 'complete',
    visibilityState: 'visible',
    navigation: {
      type: 'navigate',
      startTime: 0,
      responseStart: 10,
      domInteractive: 20,
      domContentLoadedEventEnd: 25,
      loadEventEnd: 30,
      activationStart: 0,
      name: `http://127.0.0.1:5175/products?token=${secret}`,
    },
    paintEntries: [
      { name: 'first-contentful-paint', startTime: 25, url: `?token=${secret}` },
      { name: `token=${secret}`, startTime: 26 },
    ],
    paintObserver: { supported: true, registered: true },
    lcpObserver: { supported: true, registered: true },
    deliveredObserverEntries: {
      paint: [{ name: 'first-contentful-paint', startTime: 25, text: 'private' }],
      largestContentfulPaint: [{ name: 'largest-contentful-paint', startTime: 27 }],
    },
    pendingObserverRecords: {
      paint: [{ name: 'first-contentful-paint', startTime: 28 }],
      largestContentfulPaint: [{ name: 'largest-contentful-paint', startTime: 29 }],
    },
    paintWaitTimedOut: true,
  })
  const serialized = JSON.stringify(diagnostic)

  assert.deepEqual(diagnostic.missingMetrics, [
    'firstContentfulPaintMs',
    'largestContentfulPaintMs',
  ])
  assert.equal(diagnostic.navigation.type, 'navigate')
  assert.equal(diagnostic.lcpObserver.supported, true)
  assert.equal(diagnostic.deliveredObserverEntries.largestContentfulPaint[0].startTime, 27)
  assert.equal(diagnostic.pendingObserverRecords.paint[0].startTime, 28)
  assert.equal(diagnostic.paintWaitTimedOut, true)
  for (const sensitiveValue of [secret, 'http://127.0.0.1:5175', 'private', '?token=']) {
    assert.equal(serialized.includes(sensitiveValue), false)
  }

  const unsafePath = createBrowserTimingDiagnostic({
    page: 'products',
    sample: 1,
    documentPath: `/products?token=${secret}`,
  })
  assert.equal(unsafePath.documentPath, '[unrecognized path]')
})

test('failed browser request diagnostics keep only safe origin and failure code', () => {
  const token = `123456:${'s'.repeat(32)}`
  const channelId = '-1001234567890'
  const diagnostic = createBrowserRequestFailureDiagnostic({
    page: 'home',
    sample: 2,
    method: 'GET',
    url: `http://127.0.0.1:5175/assets/app.js?token=${token}&chat_id=${channelId}&email=customer@example.test`,
    errorText: 'net::ERR_CONNECTION_REFUSED',
  })

  assert.deepEqual(diagnostic, {
    page: 'home',
    sample: 2,
    method: 'GET',
    origin: 'http://127.0.0.1:5175',
    failure: 'net::ERR_CONNECTION_REFUSED',
  })
  for (const sensitiveValue of [token, channelId, 'customer@example.test', '/assets/app.js']) {
    assert.equal(JSON.stringify(diagnostic).includes(sensitiveValue), false)
  }
})

test('baseline cart fixture is available on both measured frontend origins', () => {
  assert.deepEqual(PERFORMANCE_CART_FIXTURE_ORIGINS, [
    PERFORMANCE_FRONTEND_ORIGIN,
    PERFORMANCE_PREVIEW_ORIGIN,
  ])
})

test('API timing records separate response, JSON validation and total durations', () => {
  const serverTimingHeader = [
    'handler-entry;desc="2026-11-25T15:00:00.000Z"',
    'cache;dur=0.25;desc="miss"',
    'recent_orders_query;dur=1.5',
    'handler-total;dur=2',
    'customer@example.test;dur=999',
  ].join(', ')
  const serverTimings = parseServerTimingHeader(serverTimingHeader)
  assert.deepEqual(serverTimings, [
    { name: 'handler-entry', durationMs: null, description: '2026-11-25T15:00:00.000Z' },
    { name: 'cache', durationMs: 0.25, description: 'miss' },
    { name: 'recent_orders_query', durationMs: 1.5 },
    { name: 'handler-total', durationMs: 2 },
  ])

  const request = createApiRequestTimingRecord({
    requestNumber: 1,
    requestStartedAt: '2026-11-25T15:00:00.000Z',
    responseReceivedAt: '2026-11-25T15:00:00.006Z',
    requestEndedAt: '2026-11-25T15:00:00.010Z',
    requestStartMs: 10,
    responseReceivedMs: 16,
    requestEndMs: 20,
    jsonParseValidationDurationMs: 2.5,
    httpStatusCode: 200,
    payloadValid: true,
    serverTimingHeader,
  })

  assert.equal(request.responseDurationMs, 6)
  assert.equal(request.jsonParseValidationDurationMs, 2.5)
  assert.equal(request.totalDurationMs, 10)
  assert.equal(request.httpStatusCode, 200)
  assert.equal(request.requestStatus, 'success')
  assert.equal(request.serverTimings.length, 4)
  assert.equal(JSON.stringify(request).includes('productIds'), false)
})

test('API smoke results retain partial diagnostics for HTTP, JSON, payload and fetch failures', async () => {
  const responses = [
    {
      status: 200,
      headers: { get: (name) => name === 'server-timing' ? 'cache;dur=1.5;desc="hit"' : null },
      json: async () => ({ productIds: ['sample-product'] }),
    },
    {
      status: 503,
      headers: { get: (name) => name === 'server-timing' ? 'handler-total;dur=4' : null },
      json: async () => ({ message: 'response body must not be recorded' }),
    },
    {
      status: 200,
      headers: { get: () => null },
      json: async () => { throw new SyntaxError('response body must not be recorded') },
    },
    {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ items: [] }),
    },
    new TypeError('secret token must not be recorded'),
  ]
  let fetchCount = 0
  const result = await runApiSmokeRequests({
    url: PERFORMANCE_API_URL,
    requestCount: responses.length,
    createTimeoutSignal: () => undefined,
    fetchImpl: async (url, options) => {
      assert.equal(url, PERFORMANCE_API_URL)
      assert.equal(options.method, 'GET')
      assert.deepEqual(options.headers, { Accept: 'application/json' })
      const response = responses[fetchCount]
      fetchCount += 1
      if (response instanceof Error) throw response
      return response
    },
  })

  assert.equal(fetchCount, responses.length)
  assert.deepEqual(result.requests.map(({ requestNumber }) => requestNumber), [1, 2, 3, 4, 5])
  assert.deepEqual(result.requests.map(({ fetchSucceeded }) => fetchSucceeded), [
    true, true, true, true, false,
  ])
  assert.deepEqual(result.requests.map(({ httpStatusCode }) => httpStatusCode), [
    200, 503, 200, 200, null,
  ])
  assert.deepEqual(result.requests.map(({ jsonParsingSucceeded }) => jsonParsingSucceeded), [
    true, true, false, true, false,
  ])
  assert.deepEqual(result.requests.map(({ payloadValid }) => payloadValid), [
    true, false, false, false, false,
  ])
  assert.deepEqual(result.requests.map(({ failureReason }) => failureReason), [
    null,
    'HTTP 503',
    'Invalid JSON response',
    'Invalid productIds payload',
    'Fetch failed (TypeError)',
  ])
  assert.equal(result.requests[0].serverTimings[0].name, 'cache')
  assert.equal(result.requests[1].serverTimings[0].name, 'handler-total')
  assert.ok(result.requests.every(({ totalDurationMs }) => (
    Number.isFinite(totalDurationMs) && totalDurationMs >= 0
  )))
  assert.equal(result.metrics.totalRequests, responses.length)
  assert.equal(result.metrics.successfulRequests, 1)
  assert.equal(result.metrics.failedRequests, 4)

  const report = { api: { metrics: null, requests: [] } }
  assert.equal(persistApiSmokeResult(report, result, responses.length), false)
  assert.deepEqual(report.api.metrics, result.metrics)
  assert.deepEqual(report.api.requests, result.requests)
  const serializedRecords = JSON.stringify(report.api.requests)
  for (const privateValue of [
    'sample-product',
    'response body must not be recorded',
    'secret token must not be recorded',
  ]) {
    assert.equal(serializedRecords.includes(privateValue), false)
  }
})

test('persistent runtime reports startup and actual cache miss/hit diagnostics', async () => {
  const cacheStatuses = ['miss', 'hit', 'in-flight']
  const result = await runApiSmokeRequests({
    url: PERFORMANCE_API_URL,
    requestCount: cacheStatuses.length,
    expectedRuntime: 'persistent',
    createTimeoutSignal: () => undefined,
    fetchImpl: async () => {
      const description = cacheStatuses.shift()
      return {
        status: 200,
        headers: {
          get(name) {
            if (name === 'x-performance-api-runtime') return 'persistent'
            if (name === 'x-performance-runtime-startup-ms') return '87.625'
            if (name === 'server-timing') return `cache;dur=0.1;desc="${description}"`
            return null
          },
        },
        json: async () => ({ productIds: [] }),
      }
    },
  })

  assert.deepEqual(result.requests.map(({ cacheLatencyClass }) => cacheLatencyClass), [
    'cold', 'warm', 'coalesced',
  ])
  assert.ok(result.requests.every(({ runtimeMatches, runtimeIdentity }) => (
    runtimeMatches && runtimeIdentity === 'persistent'
  )))
  const report = { api: { metrics: null, requests: [] } }
  assert.equal(persistApiSmokeResult(report, result, 3), true)
  assert.equal(report.api.runtimeStartupMs, 87.625)
  assert.equal(report.api.cacheSummary.coldServiceCacheRequests, 1)
  assert.equal(report.api.cacheSummary.actualCacheHitRequests, 1)
  assert.equal(report.api.cacheSummary.inFlightRequests, 1)
  assert.equal(report.api.cacheSummary.coldRequestLatencyMs.length, 1)
  assert.equal(report.api.cacheSummary.warmRequestLatencyMs.length, 1)
})

test('benchmark rejects a runtime identity mismatch even with a valid API payload', async () => {
  const result = await runApiSmokeRequests({
    url: PERFORMANCE_API_URL,
    requestCount: 1,
    expectedRuntime: 'persistent',
    createTimeoutSignal: () => undefined,
    fetchImpl: async () => ({
      status: 200,
      headers: {
        get: (name) => name === 'x-performance-api-runtime' ? 'vercel' : null,
      },
      json: async () => ({ productIds: [] }),
    }),
  })
  const report = { api: { metrics: null, requests: [] } }
  assert.equal(persistApiSmokeResult(report, result, 1), false)
  assert.equal(report.api.metrics.failedRequests, 1)
  assert.equal(report.api.requests[0].requestStatus, 'runtime_mismatch')
  assert.equal(
    report.api.requests[0].failureReason,
    'Selected runtime does not match the responding API runtime',
  )
})

test('benchmark options default to smoke and reject unbounded load settings', () => {
  assert.equal(parseBenchmarkOptions([]).mode, 'smoke')
  assert.equal(parseBenchmarkOptions([]).apiRuntime, 'vercel')
  assert.equal(parseBenchmarkOptions(['--api-runtime', 'persistent']).apiRuntime, 'persistent')
  assert.throws(
    () => parseBenchmarkOptions(['--api-runtime', 'unknown']),
    /API runtime must be vercel or persistent/,
  )
  assert.deepEqual(
    {
      mode: parseBenchmarkOptions(['--mode', 'baseline']).mode,
      connections: parseBenchmarkOptions(['--mode', 'baseline']).connections,
      durationSeconds: parseBenchmarkOptions(['--mode', 'baseline']).durationSeconds,
    },
    { mode: 'baseline', connections: 1, durationSeconds: 10 },
  )
  assert.throws(
    () => parseBenchmarkOptions(['--mode', 'load', '--connections', '6']),
    /connections must be between 1 and 5/,
  )
  assert.throws(
    () => parseBenchmarkOptions(['--mode', 'load', '--duration-seconds', '31']),
    /duration must be between 1 and 30 seconds/,
  )
  assert.throws(() => parseBenchmarkOptions(['--unknown']), /Unknown benchmark option/)
})

test('API and page summaries calculate latency percentiles, throughput and errors', () => {
  const api = summarizeSamples([
    { latencyMs: 10, statusCode: 200 },
    { latencyMs: 20, statusCode: 201 },
    { latencyMs: 30, statusCode: 302 },
    { latencyMs: 40, statusCode: 500 },
  ], 1000, 1)

  assert.deepEqual(api, {
    totalRequests: 5,
    successfulRequests: 2,
    failedRequests: 3,
    averageLatencyMs: 25,
    medianLatencyMs: 25,
    p95LatencyMs: 40,
    p99LatencyMs: 40,
    requestsPerSecond: 5,
    errorRate: 0.6,
    elapsedMs: 1000,
  })

  const pages = aggregatePageSamples([
    {
      pageLoadTimeMs: 100,
      domContentLoadedMs: 50,
      firstContentfulPaintMs: 30,
      largestContentfulPaintMs: 60,
      cumulativeLayoutShift: 0,
    },
    {
      pageLoadTimeMs: 200,
      domContentLoadedMs: 80,
      firstContentfulPaintMs: 45,
      largestContentfulPaintMs: 90,
      cumulativeLayoutShift: 0.1,
    },
  ])
  assert.equal(pages.pageLoadTimeMs.median, 150)
  assert.equal(pages.domContentLoadedMs.p95, 80)
  assert.equal(pages.cumulativeLayoutShift.median, 0.05)
})

test('baseline comparison requires matching workload settings and reports metric deltas', () => {
  const baseline = {
    schemaVersion: 1,
    settings: { apiLoad: { connections: 1, durationSeconds: 10 } },
    browser: { pages: [{ id: 'products', metrics: { pageLoadTimeMs: { median: 100 } } }] },
    api: { metrics: { p95LatencyMs: 20 } },
    lighthouse: [],
  }
  const current = {
    schemaVersion: 1,
    settings: { apiLoad: { connections: 1, durationSeconds: 10 } },
    browser: { pages: [{ id: 'products', metrics: { pageLoadTimeMs: { median: 120 } } }] },
    api: { metrics: { p95LatencyMs: 25 } },
    lighthouse: [],
  }
  const comparison = compareBenchmarkResults(current, baseline)

  assert.equal(comparison.find((item) => item.metric === 'pageLoadTimeMs').delta, 20)
  assert.equal(comparison.find((item) => item.metric === 'p95LatencyMs').percentChange, 25)
  assert.throws(
    () => compareBenchmarkResults({ ...current, settings: { apiLoad: { connections: 2 } } }, baseline),
    /baseline is incompatible/,
  )
})

test('HTML report escapes untrusted strings and report files stay inside the ignored report directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gv-performance-report-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const report = {
    runId: '2026-11-25T14-00-00-000Z-test',
    timestamp: '2026-11-25T14:00:00.000Z',
    mode: 'smoke',
    status: 'passed',
    projectId: 'demo-gv-sarees',
    settings: {},
    browser: {
      pages: [],
      failedRequests: [{
        page: 'home',
        sample: 1,
        method: 'GET',
        origin: 'http://127.0.0.1:5175',
        failure: 'net::ERR_CONNECTION_REFUSED',
      }],
      errors: [{
        page: 'home',
        type: 'pageerror',
        name: 'TypeError',
        message: 'A sanitized render error',
        stack: 'at render (bundle.js:1:1)',
      }],
      missingMetrics: [{
        page: 'home',
        sample: 1,
        metrics: ['largestContentfulPaintMs'],
      }],
      timingDiagnostics: [{
        page: 'home',
        sample: 1,
        documentPath: '/',
        readyState: 'complete',
        visibilityState: 'visible',
        navigation: { type: 'navigate', timings: { responseStart: 10 } },
        paintEntries: [],
        lcpObserver: { supported: true, registered: true, errorName: null },
        deliveredObserverEntries: { paint: [], largestContentfulPaint: [] },
        pendingObserverRecords: { paint: [], largestContentfulPaint: [] },
        paintWaitTimedOut: true,
      }],
    },
    api: {
      metrics: { averageLatencyMs: 1 },
      requests: [{
        requestNumber: 1,
        requestStartedAt: '2026-11-25T14:00:00.000Z',
        requestEndedAt: '2026-11-25T14:00:00.010Z',
        responseDurationMs: 8,
        jsonParseValidationDurationMs: 1,
        totalDurationMs: 10,
        httpStatusCode: 503,
        requestStatus: 'http_error',
        fetchSucceeded: true,
        jsonParsingSucceeded: true,
        payloadValid: false,
        failureReason: 'HTTP 503',
        serverTimings: [
          { name: 'cache', durationMs: 0.25, description: 'miss' },
        ],
      }],
    },
    lighthouse: [],
    blockedExternalOrigins: ['https://fonts.googleapis.com'],
    blockedLocalEmulatorOrigins: [PERFORMANCE_FIRESTORE_ORIGIN],
    blockedLocalServiceOrigins: [],
    errors: ['<script>alert("no")</script>'],
  }
  const files = await writeBenchmarkReports({
    root,
    runId: report.runId,
    report,
    writeBaseline: true,
  })

  assert.match(renderBenchmarkHtml(report), /&lt;script&gt;/)
  assert.match(renderBenchmarkHtml(report), /Blocked external origins/)
  assert.match(renderBenchmarkHtml(report), /Blocked local emulator origins/)
  assert.match(renderBenchmarkHtml(report), /at render/)
  assert.match(renderBenchmarkHtml(report), /Failed local browser requests/)
  assert.match(renderBenchmarkHtml(report), /Missing browser timing metrics/)
  assert.match(renderBenchmarkHtml(report), /Browser timing diagnostics/)
  assert.match(renderBenchmarkHtml(report), /paintWaitTimedOut/)
  assert.match(renderBenchmarkHtml(report), /largestContentfulPaintMs/)
  assert.match(renderBenchmarkHtml(report), /Best sellers API request timings/)
  assert.match(renderBenchmarkHtml(report), /Best sellers API server timings/)
  assert.match(renderBenchmarkHtml(report), /HTTP 503/)
  assert.match(readFileSync(files.htmlPath, 'utf8'), /&lt;script&gt;/)
  assert.equal(JSON.parse(readFileSync(files.jsonPath, 'utf8')).projectId, 'demo-gv-sarees')
  assert.equal(JSON.parse(readFileSync(files.baselinePath, 'utf8')).runId, report.runId)
  assert.throws(
    () => resolvePerformanceReportPath(root, '../outside.json'),
    /inside the performance report directory/,
  )
  assert.equal(escapeHtml(`'"><`), '&#39;&quot;&gt;&lt;')
})

test('Vite proxies the read-only best-sellers route to the isolated API target', () => {
  const target = 'http://127.0.0.1:3001'
  const proxyConfig = createApiProxyConfig(target)
  assert.deepEqual(proxyConfig['/api/best-sellers'], {
    target,
    changeOrigin: true,
  })
})
