import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import autocannon from 'autocannon'
import { launch as launchChrome } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { chromium } from 'playwright'
import {
  PERFORMANCE_AUTH_ORIGIN,
  PERFORMANCE_API_ORIGIN,
  PERFORMANCE_API_URL,
  PERFORMANCE_BENCHMARK_PAGES,
  PERFORMANCE_CART_FIXTURE_ORIGINS,
  PERFORMANCE_DEFAULT_CONNECTIONS,
  PERFORMANCE_DEFAULT_DURATION_SECONDS,
  PERFORMANCE_FRONTEND_ORIGIN,
  PERFORMANCE_FIRESTORE_ORIGIN,
  PERFORMANCE_MAX_CONNECTIONS,
  PERFORMANCE_MAX_DURATION_SECONDS,
  PERFORMANCE_PREVIEW_ORIGIN,
  PERFORMANCE_SMOKE_REQUESTS,
  BROWSER_PAINT_WAIT_MS,
  aggregatePageSamples,
  assertBenchmarkPageUrl,
  assertReadOnlyApiUrl,
  collectBrowserTimingMetrics,
  compareBenchmarkResults,
  createBrowserErrorDiagnostic,
  createBrowserRequestFailureDiagnostic,
  createBrowserTimingDiagnostic,
  createRunId,
  getMissingBrowserMetricNames,
  isAllowedBrowserRequest,
  parseBenchmarkOptions,
  persistApiSmokeResult,
  resolvePerformanceReportPath,
  runApiSmokeRequests,
  summarizeSamples,
  waitForBrowserPaintMetrics,
  writeBenchmarkReports,
} from './performanceBenchmarkCore.js'
import {
  PERFORMANCE_AUTH_HOST,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
  assertServerPerformanceConfiguration,
  readEnvFile,
  readPerformanceEnvironment,
  readProductionTelegramEnvironments,
  sanitizePerformanceDiagnostic,
  validatePerformanceConfiguration,
  verifyFirestoreEmulator,
  verifyPerformanceApiBackend,
  verifyTelegramTestResources,
} from '../server/performanceSafety.js'

const root = process.cwd()
const VITE_ENTRY = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const PREVIEW_PORT = 5175
const CART_STORAGE_KEY = 'gv-sarees-cart-v1'
const CART_FIXTURE = {
  id: 'performance-seed-v1-001',
  name: 'Kanchi Pattu Celebration Saree',
  price: 8499,
  image: '/performance-placeholder.svg',
  sizeLength: '5.5 m + 0.8 m blouse piece',
  availableStock: 8,
  quantity: 1,
  reservationKey: 'benchmark-reservation-key-0001',
}

function createPerformanceChildEnvironment(explicitEnv, config) {
  const childEnv = {
    ...process.env,
    ...explicitEnv,
    APP_MODE: 'performance',
    FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
    FIRESTORE_EMULATOR_HOST: config.firestoreHost,
    FIREBASE_AUTH_EMULATOR_HOST: config.authHost,
  }
  delete childEnv.PORT
  assertServerPerformanceConfiguration(childEnv, root)
  return childEnv
}

async function validateRuntimeIsolation(apiRuntime) {
  const explicitEnv = readPerformanceEnvironment(root)
  const productionEnvironments = readProductionTelegramEnvironments(root)
  const env = {
    ...readEnvFile(resolve(root, '.env')),
    ...readEnvFile(resolve(root, '.env.local')),
    ...explicitEnv,
  }
  const config = validatePerformanceConfiguration({
    mode: 'performance',
    env,
    explicitEnv,
    productionEnvironments,
  })
  const childEnv = createPerformanceChildEnvironment(explicitEnv, config)

  await verifyTelegramTestResources(config)
  await verifyFirestoreEmulator({
    projectId: config.projectId,
    emulatorHost: config.firestoreHost,
  })
  await verifyPerformanceApiBackend({
    target: PERFORMANCE_API_ORIGIN,
    expectedRuntime: apiRuntime,
  })

  return { config, childEnv }
}

function localOrigin(value) {
  try {
    return new URL(value).origin
  } catch {
    return '[invalid URL]'
  }
}

function recordBlockedBrowserRequest(value, diagnostics) {
  let url
  try {
    url = new URL(value)
  } catch {
    diagnostics.blockedExternalOrigins.add('[invalid URL]')
    return
  }

  const origin = `${url.protocol === 'ws:' ? 'http:' : url.protocol}//${url.host}`
  if ([PERFORMANCE_FIRESTORE_ORIGIN, PERFORMANCE_AUTH_ORIGIN].includes(origin)) {
    diagnostics.blockedLocalEmulatorOrigins.add(origin)
    return
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
    diagnostics.blockedLocalServiceOrigins.add(origin)
    return
  }

  diagnostics.blockedExternalOrigins.add(origin)
}

function createWebVitalsInitScript(cartStorageKey, cartFixture) {
  return ({ storageKey, fixture, cartFixtureOrigins }) => {
    const browserGlobal = globalThis
    const supportedEntryTypes = Array.isArray(browserGlobal.PerformanceObserver?.supportedEntryTypes)
      ? browserGlobal.PerformanceObserver.supportedEntryTypes
      : []
    browserGlobal.__gvPerformanceVitals = {
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
      cumulativeLayoutShift: 0,
      observerDiagnostics: {
        paintObserver: {
          supported: supportedEntryTypes.includes('paint'),
          registered: false,
          errorName: null,
        },
        lcpObserver: {
          supported: supportedEntryTypes.includes('largest-contentful-paint'),
          registered: false,
          errorName: null,
        },
        deliveredObserverEntries: {
          paint: [],
          largestContentfulPaint: [],
        },
      },
    }

    const recordObserverEntries = (target, entries, fallbackName) => {
      for (const entry of entries) {
        const name = fallbackName || entry.name
        if ((name === 'first-paint' || name === 'first-contentful-paint' ||
             name === 'largest-contentful-paint') &&
            Number.isFinite(entry.startTime) && entry.startTime >= 0) {
          target.push({ name, startTime: entry.startTime })
        }
      }
    }

    const captureObserverError = (observerState, error) => {
      const errorName = String(error?.name || '')
      observerState.errorName = [
        'Error',
        'NotSupportedError',
        'SecurityError',
        'TypeError',
        'UnknownError',
      ].includes(errorName) ? errorName : 'ObserverError'
    }

    if (typeof browserGlobal.PerformanceObserver === 'function') {
      try {
        const paintObserver = new browserGlobal.PerformanceObserver((list) => {
          const entries = list.getEntries()
          recordObserverEntries(
            browserGlobal.__gvPerformanceVitals.observerDiagnostics.deliveredObserverEntries.paint,
            entries,
          )
          for (const entry of entries) {
            if (entry.name === 'first-contentful-paint') {
              browserGlobal.__gvPerformanceVitals.firstContentfulPaintMs = entry.startTime
            }
          }
        })
        browserGlobal.__gvPaintObserver = paintObserver
        paintObserver.observe({ type: 'paint', buffered: true })
        browserGlobal.__gvPerformanceVitals.observerDiagnostics.paintObserver.registered = true
      } catch (error) {
        captureObserverError(
          browserGlobal.__gvPerformanceVitals.observerDiagnostics.paintObserver,
          error,
        )
      }
    }

    if (typeof browserGlobal.PerformanceObserver === 'function') {
      try {
        const largestContentfulPaintObserver = new browserGlobal.PerformanceObserver((list) => {
          const entries = list.getEntries()
          recordObserverEntries(
            browserGlobal.__gvPerformanceVitals.observerDiagnostics.deliveredObserverEntries.largestContentfulPaint,
            entries,
            'largest-contentful-paint',
          )
          const lastEntry = entries[entries.length - 1]
          if (lastEntry) {
            browserGlobal.__gvPerformanceVitals.largestContentfulPaintMs = lastEntry.startTime
          }
        })
        browserGlobal.__gvLargestContentfulPaintObserver = largestContentfulPaintObserver
        largestContentfulPaintObserver.observe({
          type: 'largest-contentful-paint',
          buffered: true,
        })
        browserGlobal.__gvPerformanceVitals.observerDiagnostics.lcpObserver.registered = true
      } catch (error) {
        captureObserverError(
          browserGlobal.__gvPerformanceVitals.observerDiagnostics.lcpObserver,
          error,
        )
      }
    }

    const layoutShiftObserver = new browserGlobal.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          browserGlobal.__gvPerformanceVitals.cumulativeLayoutShift += entry.value
        }
      }
    })
    browserGlobal.__gvLayoutShiftObserver = layoutShiftObserver
    layoutShiftObserver.observe({ type: 'layout-shift', buffered: true })

    if (cartFixtureOrigins.includes(browserGlobal.location.origin) &&
        browserGlobal.location.pathname === '/cart') {
      browserGlobal.localStorage.setItem(storageKey, JSON.stringify([fixture]))
    }
  }
}

async function attachLocalNetworkGuards(context, runDiagnostics) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (isAllowedBrowserRequest(url, request.method(), request.postData() || '')) {
      await route.continue()
      return
    }
    recordBlockedBrowserRequest(url, runDiagnostics)
    await route.abort('blockedbyclient')
  })

  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (route) => {
      const url = route.url()
      if (isAllowedBrowserRequest(url)) {
        route.connectToServer()
        return
      }
      recordBlockedBrowserRequest(url, runDiagnostics)
      route.close({ code: 1008, reason: 'Non-local benchmark traffic is blocked.' })
    })
  }
}

async function collectBrowserPages({
  frontendOrigin,
  sampleCount,
  diagnostics,
}) {
  const browser = await chromium.launch({ headless: true })
  const pageResults = []
  try {
    for (const pageDefinition of PERFORMANCE_BENCHMARK_PAGES) {
      const samples = []
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const target = assertBenchmarkPageUrl(
          new URL(pageDefinition.path, frontendOrigin).href,
        )
        const context = await browser.newContext({ serviceWorkers: 'block' })
        await attachLocalNetworkGuards(context, diagnostics)
        await context.addInitScript(createWebVitalsInitScript(CART_STORAGE_KEY, CART_FIXTURE), {
          storageKey: CART_STORAGE_KEY,
          fixture: CART_FIXTURE,
          cartFixtureOrigins: PERFORMANCE_CART_FIXTURE_ORIGINS,
        })

        const page = await context.newPage()
        const pageErrors = []
        const failedLocalRequests = []
        page.on('pageerror', (error) => {
          const diagnostic = createBrowserErrorDiagnostic(
            pageDefinition.id,
            'pageerror',
            error,
          )
          pageErrors.push(diagnostic)
          diagnostics.browserErrors.push(diagnostic)
        })
        page.on('console', (message) => {
          if (message.type() !== 'error') return
          const sourceUrl = message.location()?.url
          if (sourceUrl && !isAllowedBrowserRequest(sourceUrl, 'GET')) return
          const text = message.text()
          if (text.includes('ERR_BLOCKED_BY_CLIENT')) return
          const diagnostic = createBrowserErrorDiagnostic(
            pageDefinition.id,
            'console',
            { name: 'ConsoleError', message: text },
          )
          pageErrors.push(diagnostic)
          diagnostics.browserErrors.push(diagnostic)
        })
        page.on('requestfailed', (request) => {
          if (isAllowedBrowserRequest(request.url(), request.method(), request.postData() || '')) {
            const failure = createBrowserRequestFailureDiagnostic({
              page: pageDefinition.id,
              sample: sampleIndex + 1,
              method: request.method(),
              url: request.url(),
              errorText: request.failure()?.errorText,
            })
            failedLocalRequests.push(failure)
            diagnostics.failedRequests.push(failure)
          }
        })

        const response = await page.goto(target, {
          waitUntil: 'load',
          timeout: 30_000,
        })
        if (!response?.ok()) {
          throw new Error(`Browser page ${pageDefinition.id} returned HTTP ${response?.status() ?? 'unknown'}.`)
        }
        try {
          await page.waitForFunction(
            () => Boolean(document.querySelector('#root')?.textContent?.trim()),
            null,
            { timeout: 15_000 },
          )
        } catch {
          const detail = pageErrors[0]?.message ||
            `${failedLocalRequests.length} local resource request(s) failed`
          throw new Error(`Browser page ${pageDefinition.id} did not render: ${detail}.`)
        }
        if (pageDefinition.id === 'product-details' || pageDefinition.id === 'cart') {
          await page.getByText(CART_FIXTURE.name, { exact: true }).first().waitFor({ timeout: 15_000 })
        }

        const paintMetricsObserved = await waitForBrowserPaintMetrics(
          page,
          BROWSER_PAINT_WAIT_MS,
        )
        const timingData = await page.evaluate(async (expectedPath) => {
          await new Promise((resolveFrame) => {
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
          })
          const navigation = performance.getEntriesByType('navigation')[0]
          const vitals = window.__gvPerformanceVitals || {}
          const pendingPaintEntries = (
            window.__gvPaintObserver?.takeRecords?.() || []
          ).flatMap((entry) => (
            (entry.name === 'first-paint' || entry.name === 'first-contentful-paint') &&
              Number.isFinite(entry.startTime) && entry.startTime >= 0
              ? [{ name: entry.name, startTime: entry.startTime }]
              : []
          ))
          const largestContentfulPaintEntries = (
            window.__gvLargestContentfulPaintObserver?.takeRecords?.() || []
          ).flatMap((entry) => (
            Number.isFinite(entry.startTime) && entry.startTime >= 0
              ? [{ name: 'largest-contentful-paint', startTime: entry.startTime }]
              : []
          ))
          const pendingLayoutShifts = (
            window.__gvLayoutShiftObserver?.takeRecords?.() || []
          )
          const pendingCumulativeLayoutShift = pendingLayoutShifts.reduce(
            (total, entry) => total + (entry.hadRecentInput ? 0 : entry.value),
            0,
          )
          const paintEntries = performance.getEntriesByType('paint')
            .map((entry) => ({ name: entry.name, startTime: entry.startTime }))
          return {
            documentPath: location.pathname === expectedPath
              ? expectedPath
              : '[unrecognized path]',
            readyState: document.readyState,
            visibilityState: document.visibilityState,
            navigation: navigation && {
              type: navigation.type,
              startTime: navigation.startTime,
              responseStart: navigation.responseStart,
              domInteractive: navigation.domInteractive,
              loadEventEnd: navigation.loadEventEnd,
              domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
              activationStart: navigation.activationStart,
            },
            paintEntries,
            pendingPaintEntries,
            firstContentfulPaintMs: vitals.firstContentfulPaintMs,
            largestContentfulPaintMs: vitals.largestContentfulPaintMs,
            largestContentfulPaintEntries,
            paintObserver: vitals.observerDiagnostics?.paintObserver,
            lcpObserver: vitals.observerDiagnostics?.lcpObserver,
            deliveredObserverEntries: vitals.observerDiagnostics?.deliveredObserverEntries,
            pendingObserverRecords: {
              paint: pendingPaintEntries,
              largestContentfulPaint: largestContentfulPaintEntries,
            },
            cumulativeLayoutShift: vitals.cumulativeLayoutShift + pendingCumulativeLayoutShift,
          }
        }, pageDefinition.path)
        const metrics = collectBrowserTimingMetrics({
          ...timingData,
          pendingFirstContentfulPaintEntries: timingData.pendingPaintEntries,
          pendingLargestContentfulPaintEntries: timingData.largestContentfulPaintEntries,
        })

        const missingMetrics = getMissingBrowserMetricNames(metrics)
        if (missingMetrics.length || pageErrors.length || failedLocalRequests.length) {
          diagnostics.timingDiagnostics.push(createBrowserTimingDiagnostic({
            ...timingData,
            page: pageDefinition.id,
            sample: sampleIndex + 1,
            missingMetrics,
            paintWaitTimedOut: !paintMetricsObserved,
          }))
        }
        if (missingMetrics.length) {
          diagnostics.missingMetrics.push({
            page: pageDefinition.id,
            sample: sampleIndex + 1,
            metrics: missingMetrics,
          })
        }
        if (pageErrors.length || failedLocalRequests.length) {
          throw new Error(
            `Browser page ${pageDefinition.id} sample ${sampleIndex + 1} had ${pageErrors.length} browser errors and ${failedLocalRequests.length} failed local requests.`,
          )
        }
        if (missingMetrics.length) {
          throw new Error(
            `Browser page ${pageDefinition.id} sample ${sampleIndex + 1} is missing required timing metrics: ${missingMetrics.join(', ')}.`,
          )
        }
        samples.push(metrics)
        await context.close()
      }

      pageResults.push({
        id: pageDefinition.id,
        path: pageDefinition.path,
        samples,
        metrics: aggregatePageSamples(samples),
      })
    }
  } finally {
    await browser.close()
  }

  return pageResults
}

async function runApiSmoke(apiRuntime) {
  return runApiSmokeRequests({
    url: PERFORMANCE_API_URL,
    requestCount: PERFORMANCE_SMOKE_REQUESTS,
    expectedRuntime: apiRuntime,
  })
}

async function runAutocannonLoad({ connections, durationSeconds }) {
  assertReadOnlyApiUrl(PERFORMANCE_API_URL, 'GET')
  const samples = []
  let observedNetworkErrors = 0
  const start = performance.now()

  const result = await new Promise((resolveResult, rejectResult) => {
    const instance = autocannon({
      url: PERFORMANCE_API_URL,
      method: 'GET',
      connections,
      duration: durationSeconds,
      pipelining: 1,
      headers: { Accept: 'application/json' },
      title: 'GV Sarees isolated best-sellers read-only benchmark',
    }, (error, stats) => {
      if (error) {
        rejectResult(new Error('Autocannon could not complete the read-only API benchmark.'))
        return
      }
      resolveResult(stats)
    })

    instance.on('response', (_client, statusCode, _bytes, responseTime) => {
      samples.push({ latencyMs: responseTime, statusCode })
    })
    instance.on('reqError', () => {
      observedNetworkErrors += 1
    })
    instance.on('error', () => {
      rejectResult(new Error('Autocannon encountered a local API request error.'))
    })
  })

  const elapsedMs = performance.now() - start
  const networkErrors = Math.max(observedNetworkErrors, Number(result.errors) || 0)
  return summarizeSamples(samples, elapsedMs, networkErrors)
}

async function assertPreviewPortAvailable(port) {
  await new Promise((resolveAvailable, rejectAvailable) => {
    const server = createServer()
    server.once('error', () => rejectAvailable(new Error(
      `The isolated Lighthouse preview port ${port} is already in use.`,
    )))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) rejectAvailable(new Error('Unable to release the isolated Lighthouse preview port.'))
        else resolveAvailable()
      })
    })
  })
}

function runPerformanceBuild(outputDirectory, childEnv) {
  const outputFromTemp = relative(resolve(tmpdir()), resolve(outputDirectory))
  if (!outputFromTemp || outputFromTemp === '..' ||
      outputFromTemp.startsWith(`..${sep}`)) {
    throw new Error('The temporary Lighthouse build directory is outside the system temp directory.')
  }

  const result = spawnSync(process.execPath, [
    VITE_ENTRY,
    'build',
    '--mode',
    'performance',
    '--outDir',
    outputDirectory,
    '--emptyOutDir',
  ], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    timeout: 180_000,
  })

  if (result.error || result.status !== 0) {
    throw new Error('The isolated performance-mode Lighthouse build failed.')
  }
}

async function waitForPreview(previewProcess, origin) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline &&
      previewProcess.exitCode === null &&
      !previewProcess.startFailed) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) })
      if (response.status === 200) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = sanitizePerformanceDiagnostic(error?.message || error, 160)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`The isolated Lighthouse preview did not become ready (${lastError || 'process exited'}).`)
}

async function startLighthousePreview(outputDirectory, childEnv) {
  await assertPreviewPortAvailable(PREVIEW_PORT)
  const previewProcess = spawn(process.execPath, [
    VITE_ENTRY,
    'preview',
    '--mode',
    'performance',
    '--host',
    '127.0.0.1',
    '--port',
    String(PREVIEW_PORT),
    '--strictPort',
    '--outDir',
    outputDirectory,
  ], {
    cwd: root,
    env: childEnv,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  })
  previewProcess.once('error', () => {
    previewProcess.startFailed = true
  })
  await waitForPreview(previewProcess, PERFORMANCE_PREVIEW_ORIGIN)
  return previewProcess
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
  ])
}

async function runLighthouseAudit(pageDefinition, outputOrigin) {
  const url = assertBenchmarkPageUrl(new URL(pageDefinition.path, outputOrigin).href)
  const chrome = await launchChrome({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  })

  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      maxWaitForLoad: 45_000,
    }, {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance'],
        formFactor: 'mobile',
        throttlingMethod: 'simulate',
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          disabled: false,
        },
      },
    })

    const audits = result?.lhr?.audits || {}
    const numericAudit = (id) => {
      const value = audits[id]?.numericValue
      return Number.isFinite(value) ? value : null
    }
    const score = result?.lhr?.categories?.performance?.score

    return {
      id: pageDefinition.id,
      path: pageDefinition.path,
      metrics: {
        performanceScore: Number.isFinite(score) ? score * 100 : null,
        firstContentfulPaintMs: numericAudit('first-contentful-paint'),
        largestContentfulPaintMs: numericAudit('largest-contentful-paint'),
        cumulativeLayoutShift: numericAudit('cumulative-layout-shift'),
      },
    }
  } finally {
    await chrome.kill()
  }
}

function buildSettings(mode, options) {
  return {
    benchmarkPages: PERFORMANCE_BENCHMARK_PAGES.map(({ id, path }) => ({ id, path })),
    browserSamplesPerPage: mode === 'smoke' ? 1 : mode === 'load' ? 0 : 3,
    lighthouse: mode === 'baseline' || mode === 'compare'
      ? { formFactor: 'mobile', throttling: 'simulated' }
      : null,
    apiEndpoint: PERFORMANCE_API_URL,
    apiRuntime: options.apiRuntime,
    apiLoad: mode === 'smoke'
      ? { type: 'smoke', requests: PERFORMANCE_SMOKE_REQUESTS, connections: 1 }
      : {
          type: 'autocannon',
          connections: options.connections,
          durationSeconds: options.durationSeconds,
          pipelining: 1,
        },
  }
}

async function runSmokeChecks(diagnostics, apiRuntime, onApiResult) {
  const frontendResponse = await fetch(`${PERFORMANCE_FRONTEND_ORIGIN}/`, {
    signal: AbortSignal.timeout(5000),
  })
  if (frontendResponse.status !== 200) {
    throw new Error(`Performance frontend smoke check returned HTTP ${frontendResponse.status}.`)
  }

  const { metrics: apiMetrics, requests: apiRequests } = await runApiSmoke(apiRuntime)
  onApiResult({ metrics: apiMetrics, requests: apiRequests })

  const browserPages = await collectBrowserPages({
    frontendOrigin: PERFORMANCE_FRONTEND_ORIGIN,
    sampleCount: 1,
    diagnostics,
  })
  return { browserPages, apiMetrics, apiRequests }
}

async function readBaseline(rootDirectory, candidate) {
  const path = resolvePerformanceReportPath(rootDirectory, candidate)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    throw new Error('The selected local benchmark baseline could not be read.')
  }
}

async function main(argv) {
  const options = parseBenchmarkOptions(argv)
  if (options.help) {
    console.info('Usage: npm run benchmark -- --mode smoke|baseline|compare|load [--api-runtime vercel|persistent] [--baseline-file PATH] [--connections 1-5] [--duration-seconds 1-30]')
    return
  }

  const runId = createRunId()
  const report = {
    schemaVersion: 1,
    runId,
    timestamp: new Date().toISOString(),
    mode: options.mode,
    status: 'running',
    projectId: null,
    settings: buildSettings(options.mode, options),
    smoke: null,
    browser: {
      pages: [],
      errors: [],
      failedRequests: [],
      missingMetrics: [],
      timingDiagnostics: [],
    },
    api: {
      metrics: null,
      requests: [],
      runtimeStartupMs: null,
      cacheSummary: null,
    },
    lighthouse: [],
    comparison: null,
    blockedExternalOrigins: [],
    blockedLocalEmulatorOrigins: [],
    blockedLocalServiceOrigins: [],
    errors: [],
  }
  report.browser.errors = []
  const diagnostics = {
    blockedExternalOrigins: new Set(),
    blockedLocalEmulatorOrigins: new Set(),
    blockedLocalServiceOrigins: new Set(),
    browserErrors: [],
    failedRequests: [],
    missingMetrics: [],
    timingDiagnostics: [],
  }
  let previewProcess
  let tempBuildDirectory

  try {
    const { config, childEnv } = await validateRuntimeIsolation(options.apiRuntime)
    report.projectId = config.projectId
    let apiSmokePassed = false
    const smoke = await runSmokeChecks(diagnostics, options.apiRuntime, (apiResult) => {
      apiSmokePassed = persistApiSmokeResult(report, apiResult, PERFORMANCE_SMOKE_REQUESTS)
    })
    if (!apiSmokePassed) {
      throw new Error('Read-only best-sellers API smoke check failed.')
    }
    report.smoke = {
      passed: true,
      browserPages: smoke.browserPages.map((page) => page.id),
      apiRequests: smoke.apiMetrics.totalRequests,
    }

    if (options.mode === 'smoke') {
      report.browser.pages = smoke.browserPages
      report.api.metrics = smoke.apiMetrics
    } else if (options.mode === 'load') {
      report.browser.pages = smoke.browserPages
      report.api.metrics = await runAutocannonLoad(options)
    } else {
      tempBuildDirectory = await mkdtemp(resolve(tmpdir(), `gv-sarees-performance-${runId}-`))
      runPerformanceBuild(tempBuildDirectory, childEnv)
      previewProcess = await startLighthousePreview(tempBuildDirectory, childEnv)
      report.browser.pages = await collectBrowserPages({
        frontendOrigin: PERFORMANCE_PREVIEW_ORIGIN,
        sampleCount: 3,
        diagnostics,
      })
      report.lighthouse = []
      for (const pageDefinition of PERFORMANCE_BENCHMARK_PAGES) {
        report.lighthouse.push(await runLighthouseAudit(
          pageDefinition,
          PERFORMANCE_PREVIEW_ORIGIN,
        ))
      }
      report.api.metrics = await runAutocannonLoad(options)
    }

    report.blockedExternalOrigins = [...diagnostics.blockedExternalOrigins].sort()
    report.status = 'passed'

    if (options.mode === 'compare') {
      const baselinePath = options.baselineFile || '.performance-reports/baseline.json'
      const baseline = await readBaseline(root, baselinePath)
      report.comparison = compareBenchmarkResults(report, baseline)
    }
  } catch (error) {
    report.status = 'failed'
    report.errors.push(sanitizePerformanceDiagnostic(error?.message || error, 300))
    report.blockedExternalOrigins = [...diagnostics.blockedExternalOrigins].sort()
  } finally {
    await stopChild(previewProcess)
    if (tempBuildDirectory) {
      await rm(tempBuildDirectory, { recursive: true, force: true })
    }
    report.browser.errors = diagnostics.browserErrors
    report.browser.failedRequests = diagnostics.failedRequests
    report.browser.missingMetrics = diagnostics.missingMetrics
    report.browser.timingDiagnostics = diagnostics.timingDiagnostics
    report.blockedExternalOrigins = [...diagnostics.blockedExternalOrigins].sort()
    report.blockedLocalEmulatorOrigins = [...diagnostics.blockedLocalEmulatorOrigins].sort()
    report.blockedLocalServiceOrigins = [...diagnostics.blockedLocalServiceOrigins].sort()
  }

  const reportFiles = await writeBenchmarkReports({
    root,
    runId,
    report,
    baselineFile: options.baselineFile || '.performance-reports/baseline.json',
    writeBaseline: options.mode === 'baseline' && report.status === 'passed',
  })

  console.info(`Performance benchmark ${report.status}.`)
  console.info(`JSON report: ${relative(root, reportFiles.jsonPath)}`)
  console.info(`HTML report: ${relative(root, reportFiles.htmlPath)}`)
  if (reportFiles.baselinePath) {
    console.info(`Baseline: ${relative(root, reportFiles.baselinePath)}`)
  }
  if (report.errors.length) {
    console.error(`Diagnostic: ${report.errors[0]}`)
    process.exitCode = 1
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Performance benchmark failed: ${sanitizePerformanceDiagnostic(error?.message || error, 300)}`)
  process.exitCode = 1
})
