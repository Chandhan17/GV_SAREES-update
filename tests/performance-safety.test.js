import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PERFORMANCE_EMULATOR_HUB_HOST,
  PERFORMANCE_API_RUNTIME_HEADER,
  PERFORMANCE_API_STARTUP_HEADER,
  PERFORMANCE_API_RUNTIME_IDS,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
  assertServerPerformanceConfiguration,
  createPerformanceWriteGuard,
  resolvePerformanceEnvironment,
  sanitizePerformanceDiagnostic,
  validatePerformanceConfiguration,
  verifyFirestoreEmulator,
  verifyPerformanceApiBackend,
  verifyPerformanceWriteSafety,
  verifyTelegramTestResources,
  getPerformanceApiRuntimeIdentity,
} from '../server/performanceSafety.js'

function performanceEnv(overrides = {}) {
  return {
    TELEGRAM_TEST_MODE: '1',
    TELEGRAM_TEST_BOT_USERNAME: 'dedicated_test_bot',
    TELEGRAM_BOT_TOKEN: `123456:${'t'.repeat(32)}`,
    TELEGRAM_CHANNEL_ID: '-1001234567890',
    FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    VITE_FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
    VITE_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    VITE_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    VITE_FIREBASE_API_KEY: 'demo-api-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
    VITE_FIREBASE_STORAGE_BUCKET: 'demo-gv-sarees.appspot.com',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
    VITE_FIREBASE_APP_ID: '1:000000000000:web:performance',
    RESERVATION_TOKEN_SECRET: 'performance-only-reservation-token-secret',
    RAZORPAY_KEY_ID: 'rzp_test_performance_key',
    RAZORPAY_KEY_SECRET: 'performance-only-razorpay-secret',
    VITE_RAZORPAY_KEY_ID: 'rzp_test_performance_key',
    ...overrides,
  }
}

function createPerformanceEnvironmentRoot(t, env = performanceEnv(), files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gv-performance-safety-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const serialize = (values) => Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  writeFileSync(join(root, '.env.performance.local'), serialize(env))
  for (const [name, values] of Object.entries(files)) {
    writeFileSync(join(root, name), serialize(values))
  }
  return root
}

function validate(env, options = {}) {
  return validatePerformanceConfiguration({
    mode: 'performance',
    env,
    explicitEnv: env,
    ...options,
  })
}

function telegramSuccess(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  }
}

function assertSafeTelegramDiagnostic(error, config, operation, category) {
  const diagnostic = sanitizePerformanceDiagnostic(error.message)
  assert.equal(diagnostic, `Telegram ${operation} verification failed: ${category}.`)
  for (const sensitiveValue of [
    config.telegramToken,
    config.telegramChannelId,
    `https://api.telegram.org/bot${config.telegramToken}/`,
    'private.user@example.test',
    'mock response secret',
  ]) {
    assert.equal(diagnostic.includes(sensitiveValue), false)
  }
}

function emulatorHubResponse(overrides = {}) {
  return {
    firestore: {
      name: 'firestore',
      host: '127.0.0.1',
      port: 8080,
      listen: [{ address: '127.0.0.1', port: 8080, family: 'IPv4' }],
      ...overrides,
    },
  }
}

test('performance configuration rejects missing test mode and incomplete credentials', () => {
  const missingMode = performanceEnv({ TELEGRAM_TEST_MODE: '0' })
  assert.throws(() => validate(missingMode), /TELEGRAM_TEST_MODE=1/)

  const missingChannel = performanceEnv({ TELEGRAM_CHANNEL_ID: '' })
  assert.throws(() => validate(missingChannel), /configuration is incomplete/)

  const missingToken = performanceEnv({ TELEGRAM_BOT_TOKEN: '' })
  assert.throws(() => validate(missingToken), /configuration is incomplete/)

  const missingProject = performanceEnv({ FIREBASE_PROJECT_ID: '' })
  assert.throws(() => validate(missingProject), /configuration is incomplete/)

  const missingReservationSecret = performanceEnv({ RESERVATION_TOKEN_SECRET: '' })
  assert.throws(() => validate(missingReservationSecret), /configuration is incomplete/)

  for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'VITE_RAZORPAY_KEY_ID']) {
    assert.throws(() => validate(performanceEnv({ [key]: '' })), /configuration is incomplete/)
  }
})

test('performance configuration requires a long, production-distinct reservation secret', () => {
  assert.throws(() => validate(performanceEnv({
    RESERVATION_TOKEN_SECRET: 'too-short',
  })), /at least 32 bytes/)

  const env = performanceEnv()
  assert.throws(() => validate(env, {
    productionEnvironments: [{
      RESERVATION_TOKEN_SECRET: env.RESERVATION_TOKEN_SECRET,
    }],
  }), /must not match production configuration/)
})

test('performance Razorpay configuration requires matching test credentials distinct from production', () => {
  assert.throws(() => validate(performanceEnv({
    RAZORPAY_KEY_ID: 'rzp_live_not_allowed',
    VITE_RAZORPAY_KEY_ID: 'rzp_live_not_allowed',
  })), /Razorpay test-mode credentials/)

  assert.throws(() => validate(performanceEnv({
    VITE_RAZORPAY_KEY_ID: 'rzp_test_different_key',
  })), /key IDs must match/)

  const env = performanceEnv()
  for (const key of ['RAZORPAY_KEY_ID', 'VITE_RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) {
    assert.throws(() => validate(env, {
      productionEnvironments: [{ [key]: env[key] }],
    }), /must not match production configuration/)
  }
})

test('performance configuration rejects an invalid mode', () => {
  const env = performanceEnv()
  assert.throws(() => validatePerformanceConfiguration({
    mode: 'development',
    env,
    explicitEnv: env,
  }), /outside performance mode/)
})

test('performance environment replaces known production overrides with dedicated values', () => {
  const explicitEnv = performanceEnv()
  const productionEnv = {
    TELEGRAM_BOT_TOKEN: `987654:${'p'.repeat(32)}`,
    TELEGRAM_CHANNEL_ID: '-1009876543210',
    FIREBASE_PROJECT_ID: 'production-project',
    FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
    FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443',
    VITE_FIREBASE_PROJECT_ID: 'production-project',
    VITE_FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
    VITE_FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443',
    VITE_FIREBASE_API_KEY: 'production-api-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'production.example.com',
    VITE_FIREBASE_STORAGE_BUCKET: 'production.appspot.com',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '987654321',
    VITE_FIREBASE_APP_ID: '1:987654321:web:production',
    VITE_API_BASE_URL: 'https://production.example.com',
    RESERVATION_TOKEN_SECRET: 'production-reservation-token-secret',
    RAZORPAY_KEY_ID: 'rzp_test_production_key',
    RAZORPAY_KEY_SECRET: 'production-razorpay-secret',
    VITE_RAZORPAY_KEY_ID: 'rzp_test_production_key',
  }
  const inheritedEnv = {
    ...explicitEnv,
    ...productionEnv,
    APP_MODE: 'performance',
  }
  const resolvedEnv = resolvePerformanceEnvironment({
    env: inheritedEnv,
    explicitEnv,
    productionEnvironments: [productionEnv],
  })

  const config = validatePerformanceConfiguration({
    mode: 'performance',
    env: resolvedEnv,
    explicitEnv,
    productionEnvironments: [productionEnv],
  })

  assert.equal(config.projectId, PERFORMANCE_PROJECT_ID)
  assert.equal(resolvedEnv.TELEGRAM_BOT_TOKEN === explicitEnv.TELEGRAM_BOT_TOKEN, true)
  assert.equal(resolvedEnv.TELEGRAM_CHANNEL_ID === explicitEnv.TELEGRAM_CHANNEL_ID, true)
  assert.equal(
    resolvedEnv.RESERVATION_TOKEN_SECRET === explicitEnv.RESERVATION_TOKEN_SECRET,
    true,
  )
  assert.equal(resolvedEnv.RAZORPAY_KEY_ID, explicitEnv.RAZORPAY_KEY_ID)
  assert.equal(resolvedEnv.RAZORPAY_KEY_SECRET, explicitEnv.RAZORPAY_KEY_SECRET)
  assert.equal(resolvedEnv.VITE_RAZORPAY_KEY_ID, explicitEnv.VITE_RAZORPAY_KEY_ID)
  assert.equal(resolvedEnv.VITE_FIREBASE_PROJECT_ID === PERFORMANCE_PROJECT_ID, true)
  assert.equal(Object.hasOwn(resolvedEnv, 'VITE_API_BASE_URL'), false)
})

test('performance admin allowlist comes from the dedicated environment, not inherited production settings', () => {
  const testAdminEmail = 'perf-admin@gvsarees.test'
  const productionEnv = { VITE_ADMIN_EMAILS: 'production-admin@example.invalid' }
  const explicitEnv = performanceEnv({ VITE_ADMIN_EMAILS: testAdminEmail })
  const resolvedEnv = resolvePerformanceEnvironment({
    env: { ...explicitEnv, ...productionEnv },
    explicitEnv,
    productionEnvironments: [productionEnv],
  })

  assert.equal(resolvedEnv.VITE_ADMIN_EMAILS, testAdminEmail)

  const withoutPerformanceAllowlist = performanceEnv()
  const inheritedOnlyEnv = resolvePerformanceEnvironment({
    env: { ...withoutPerformanceAllowlist, ...productionEnv },
    explicitEnv: withoutPerformanceAllowlist,
    productionEnvironments: [productionEnv],
  })

  assert.equal(Object.hasOwn(inheritedOnlyEnv, 'VITE_ADMIN_EMAILS'), false)
})

test('performance environment rejects unrecognized inherited conflicts without exposing values', () => {
  const explicitEnv = performanceEnv()
  const conflictingValue = 'unexpected-test-configuration'
  for (const key of [
    'VITE_FIREBASE_PROJECT_ID',
    'RESERVATION_TOKEN_SECRET',
    'RAZORPAY_KEY_SECRET',
  ]) {
    assert.throws(
      () => resolvePerformanceEnvironment({
        env: { ...explicitEnv, [key]: conflictingValue },
        explicitEnv,
      }),
      (error) => {
        assert.match(error.message, new RegExp(key))
        assert.doesNotMatch(error.message, new RegExp(conflictingValue))
        return true
      },
    )
  }
})

test('performance configuration rejects production fallback and matching production resources', () => {
  const env = performanceEnv()
  assert.throws(() => validatePerformanceConfiguration({
    mode: 'performance',
    env,
    explicitEnv: { TELEGRAM_TEST_MODE: '1' },
    productionEnvironments: [],
  }), /configuration is incomplete/)

  assert.throws(() => validate(env, {
    productionEnvironments: [{
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    }],
  }), /must not match production resources/)

  assert.throws(() => validate(env, {
    productionEnvironments: [{
      TELEGRAM_CHANNEL_ID: env.TELEGRAM_CHANNEL_ID,
    }],
  }), /must not match production resources/)
})

test('performance configuration refuses a non-emulator project or remote host', () => {
  assert.throws(() => validate(performanceEnv({
    FIREBASE_PROJECT_ID: 'production-project',
  })), /demo-gv-sarees/)

  assert.throws(() => validate(performanceEnv({
    FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
  })), /local Firebase Emulator/)
})

test('Telegram resource verification requires the expected bot, private test channel, and posting permission', async () => {
  const config = validate(performanceEnv())
  const apiResults = [
    { id: 12, username: 'dedicated_test_bot' },
    { id: '-1001234567890', type: 'channel', title: 'Private Test Channel' },
    { status: 'administrator', can_post_messages: true },
  ]
  const calls = []
  const mockFetch = async (url, options) => {
    calls.push({ url, options })
    return telegramSuccess(apiResults.shift())
  }

  assert.equal(await verifyTelegramTestResources(config, mockFetch), true)
  assert.deepEqual(calls.map(({ url }) => url.split('/').at(-1)), [
    'getMe',
    'getChat',
    'getChatMember',
  ])
  assert.equal(calls[1].options.body.includes(config.telegramChannelId), true)

  await assert.rejects(
    verifyTelegramTestResources(config, async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12, username: 'other_test_bot' } }),
    })),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getMe', 'identity validation mismatch')
      return true
    },
  )
})

test('Telegram verification diagnostics identify network failures without sensitive details', async () => {
  const config = validate(performanceEnv())
  await assert.rejects(
    verifyTelegramTestResources(config, async (url) => {
      const error = new Error(
        `Connection failed for ${url}; ${config.telegramChannelId}; private.user@example.test`,
      )
      error.code = 'ECONNREFUSED'
      throw error
    }),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getMe', 'network/connection failure')
      return true
    },
  )
})

test('Telegram verification diagnostics identify timeouts without sensitive details', async () => {
  const config = validate(performanceEnv())
  await assert.rejects(
    verifyTelegramTestResources(config, async (url) => {
      if (url.endsWith('/getMe')) {
        return telegramSuccess({ id: 12, username: 'dedicated_test_bot' })
      }
      const error = new Error(
        `Timed out for ${url}; ${config.telegramChannelId}; private.user@example.test`,
      )
      error.name = 'TimeoutError'
      throw error
    }),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getChat', 'timeout')
      return true
    },
  )
})

test('Telegram verification diagnostics identify API rejections without response details', async () => {
  const config = validate(performanceEnv())
  await assert.rejects(
    verifyTelegramTestResources(config, async (url) => {
      if (url.endsWith('/getMe')) {
        return telegramSuccess({ id: 12, username: 'dedicated_test_bot' })
      }
      if (url.endsWith('/getChat')) {
        return telegramSuccess({
          type: 'channel',
          title: 'Private Test Channel',
        })
      }
      return {
        ok: true,
        json: async () => ({
          ok: false,
          description: `Rejected ${config.telegramChannelId} mock response secret`,
        }),
      }
    }),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getChatMember', 'Telegram API rejection')
      return true
    },
  )
})

test('Telegram getChat reports resource mismatches without exposing returned details', async () => {
  const config = validate(performanceEnv())
  await assert.rejects(
    verifyTelegramTestResources(config, async (url) => {
      if (url.endsWith('/getMe')) {
        return telegramSuccess({ id: 12, username: 'dedicated_test_bot' })
      }
      return telegramSuccess({
        id: config.telegramChannelId,
        type: 'group',
        title: 'private.user@example.test',
      })
    }),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getChat', 'resource validation mismatch')
      return true
    },
  )
})

test('Telegram getChatMember reports permission failures without exposing returned details', async () => {
  const config = validate(performanceEnv())
  await assert.rejects(
    verifyTelegramTestResources(config, async (url) => {
      if (url.endsWith('/getMe')) {
        return telegramSuccess({ id: 12, username: 'dedicated_test_bot' })
      }
      if (url.endsWith('/getChat')) {
        return telegramSuccess({
          type: 'channel',
          title: 'Private Test Channel',
        })
      }
      return telegramSuccess({
        status: 'member',
        can_post_messages: false,
        user: { first_name: 'private.user@example.test' },
      })
    }),
    (error) => {
      assertSafeTelegramDiagnostic(error, config, 'getChatMember', 'permission failure')
      return true
    },
  )
})

test('Firestore emulator verification requires the demo project and local emulator host', async () => {
  let fetchCalled = false
  const fetchImpl = async () => {
    fetchCalled = true
    return {
      ok: true,
      status: 404,
      json: async () => emulatorHubResponse(),
    }
  }

  await assert.rejects(
    verifyFirestoreEmulator({
      projectId: 'production-project',
      fetchImpl,
    }),
    /configured Firebase Emulator could not be verified/,
  )
  await assert.rejects(
    verifyFirestoreEmulator({
      emulatorHost: 'firestore.googleapis.com:443',
      fetchImpl,
    }),
    /configured Firebase Emulator could not be verified/,
  )
  await assert.rejects(
    verifyFirestoreEmulator({
      emulatorHost: '127.0.0.1:8081',
      fetchImpl,
    }),
    /configured Firebase Emulator could not be verified/,
  )
  assert.equal(fetchCalled, false)
})

test('Firestore verification queries the local Emulator Hub and validates its Firestore listener', async () => {
  let requestedUrl
  const fetchImpl = async (url) => {
    requestedUrl = url
    return {
      ok: true,
      status: 200,
      json: async () => emulatorHubResponse(),
    }
  }

  assert.equal(await verifyFirestoreEmulator({ fetchImpl }), true)
  assert.equal(requestedUrl, `http://${PERFORMANCE_EMULATOR_HUB_HOST}/emulators`)
  assert.equal(PERFORMANCE_FIRESTORE_HOST, '127.0.0.1:8080')
})

test('Firestore emulator verification rejects connection failures', async () => {
  await assert.rejects(
    verifyFirestoreEmulator({
      fetchImpl: async () => {
        throw new Error('network offline')
      },
    }),
    /connectivity could not be verified/,
  )
})

test('Firestore emulator verification rejects HTTP errors, malformed and unexpected hub responses', async () => {
  for (const status of [400, 403, 500]) {
    await assert.rejects(
      verifyFirestoreEmulator({
        fetchImpl: async () => ({
          ok: false,
          status,
          json: async () => ({}),
        }),
      }),
      /connectivity could not be verified/,
    )
  }

  await assert.rejects(
    verifyFirestoreEmulator({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('invalid JSON')
        },
      }),
    }),
    /connectivity could not be verified/,
  )

  for (const response of [
    {},
    { name: 'auth', host: '127.0.0.1', port: 8080, listen: [{ address: '127.0.0.1', port: 8080 }] },
    { name: 'firestore', host: 'firestore.googleapis.com', port: 8080, listen: [{ address: '127.0.0.1', port: 8080 }] },
    { name: 'firestore', host: '127.0.0.1', port: 8080, listen: [{ address: '0.0.0.0', port: 8080 }] },
    { name: 'firestore', host: '127.0.0.1', port: 8081, listen: [{ address: '127.0.0.1', port: 8081 }] },
  ]) {
    await assert.rejects(
      verifyFirestoreEmulator({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ firestore: response }),
        }),
      }),
      /connectivity could not be verified/,
    )
  }
})

test('emulator disconnection blocks performance writes before reaching the API backend', async () => {
  let backendRequested = false
  let nextCalled = false
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
  const guard = createPerformanceWriteGuard({
    verify: () => verifyPerformanceWriteSafety({
      fetchImpl: async (url) => {
        if (url.includes('/api/test')) backendRequested = true
        throw new Error('emulator disconnected')
      },
    }),
  })

  await guard({ method: 'POST' }, res, () => {
    nextCalled = true
  })

  assert.equal(res.statusCode, 503)
  assert.match(res.body, /no upload or write was sent/)
  assert.equal(nextCalled, false)
  assert.equal(backendRequested, false)
})

test('server performance configuration rejects production Firebase credentials', (t) => {
  const env = {
    ...performanceEnv(),
    APP_MODE: 'performance',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{"private_key":"never logged"}',
  }

  assert.throws(() => assertServerPerformanceConfiguration(
    env,
    createPerformanceEnvironmentRoot(t),
  ), /not allowed/)
})

test('server performance configuration loads explicit values and rejects production Razorpay reuse', (t) => {
  const env = { APP_MODE: 'performance' }
  const explicitEnv = performanceEnv()
  const root = createPerformanceEnvironmentRoot(t, explicitEnv)

  assert.equal(assertServerPerformanceConfiguration(env, root), true)
  for (const key of Object.keys(explicitEnv)) {
    assert.equal(env[key] === explicitEnv[key], true)
  }

  const productionRoot = createPerformanceEnvironmentRoot(t, explicitEnv, {
    '.env': {
      RAZORPAY_KEY_ID: explicitEnv.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: explicitEnv.RAZORPAY_KEY_SECRET,
      VITE_RAZORPAY_KEY_ID: explicitEnv.VITE_RAZORPAY_KEY_ID,
    },
  })
  assert.throws(
    () => assertServerPerformanceConfiguration({ APP_MODE: 'performance' }, productionRoot),
    /Razorpay credentials must not match production configuration/,
  )
})

test('performance API backend reports failed emulator-isolation checks without exposing response values', async () => {
  await assert.rejects(
    verifyPerformanceApiBackend({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          performanceMode: false,
          projectId: 'production-project-id',
          emulatorVerified: false,
          message: 'Customer email customer@example.com; token=private-token',
          privateKey: 'private-key-value',
        }),
      }),
    }),
    (error) => {
      assert.match(error.message, /failed emulator-isolation checks \(HTTP 200\)/)
      assert.match(error.message, /"projectId":"\[redacted\]"/)
      assert.match(error.message, /"message":"\[omitted\]"/)
      assert.equal(error.message.includes('production-project-id'), false)
      assert.equal(error.message.includes('customer@example.com'), false)
      assert.equal(error.message.includes('private-token'), false)
      assert.equal(error.message.includes('private-key-value'), false)
      return true
    },
  )

  assert.equal(await verifyPerformanceApiBackend({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        performanceMode: true,
        projectId: PERFORMANCE_PROJECT_ID,
        emulatorVerified: true,
      }),
    }),
  }), true)
})

test('runtime identity is marked only by verified local Vercel performance environment', () => {
  const env = {
    APP_MODE: 'performance',
    GV_PERFORMANCE_API_RUNTIME: 'vercel',
    VERCEL: '1',
    VERCEL_ENV: 'development',
  }
  assert.equal(getPerformanceApiRuntimeIdentity(env), PERFORMANCE_API_RUNTIME_IDS.vercel)
  assert.equal(getPerformanceApiRuntimeIdentity({ ...env, VERCEL: '0' }), null)
  assert.equal(getPerformanceApiRuntimeIdentity({ ...env, VERCEL_ENV: 'production' }), null)
  assert.equal(getPerformanceApiRuntimeIdentity({ ...env, APP_MODE: 'production' }), null)
  assert.equal(getPerformanceApiRuntimeIdentity({
    ...env,
    GV_PERFORMANCE_API_RUNTIME: PERFORMANCE_API_RUNTIME_IDS.persistent,
  }), null)
})

test('performance API readiness rejects a runtime identity mismatch', async () => {
  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (name) => name === PERFORMANCE_API_RUNTIME_HEADER ? 'vercel' : null,
    },
    json: async () => ({
      performanceMode: true,
      projectId: PERFORMANCE_PROJECT_ID,
      emulatorVerified: true,
    }),
  }
  await assert.rejects(
    verifyPerformanceApiBackend({
      expectedRuntime: 'persistent',
      fetchImpl: async () => response,
    }),
    /runtime does not match/,
  )
  assert.equal(await verifyPerformanceApiBackend({
    expectedRuntime: 'vercel',
    fetchImpl: async () => response,
  }), true)
  await assert.rejects(
    verifyPerformanceApiBackend({
      expectedRuntime: 'persistent',
      fetchImpl: async () => ({
        ...response,
        headers: {
          get: (name) => name === PERFORMANCE_API_RUNTIME_HEADER ? 'persistent' : null,
        },
      }),
    }),
    /startup timing is unavailable/,
  )
  assert.equal(await verifyPerformanceApiBackend({
    expectedRuntime: 'persistent',
    fetchImpl: async () => ({
      ...response,
      headers: {
        get: (name) => {
          if (name === PERFORMANCE_API_RUNTIME_HEADER) return 'persistent'
          if (name === PERFORMANCE_API_STARTUP_HEADER) return '71.23'
          return null
        },
      },
    }),
  }), true)
  await assert.rejects(
    verifyPerformanceApiBackend({
      expectedRuntime: 'unknown',
      fetchImpl: async () => response,
    }),
    /Expected performance API runtime is invalid/,
  )
})

test('performance API backend reports HTTP 404 and 500 with sanitized response summaries', async () => {
  for (const [status, label] of [
    [404, 'HTTP 404 Not Found'],
    [500, 'HTTP 500 Internal Server Error'],
  ]) {
    await assert.rejects(
      verifyPerformanceApiBackend({
        fetchImpl: async () => ({
          ok: false,
          status,
          text: async () => '<html>customer@example.com token=private-token</html>',
        }),
      }),
      (error) => {
        assert.ok(error.message.includes(label))
        assert.match(error.message, /non-JSON body omitted/)
        assert.equal(error.message.includes('customer@example.com'), false)
        assert.equal(error.message.includes('private-token'), false)
        return true
      },
    )
  }
})

test('performance API backend reports connection refusal and timeout details', async () => {
  const refusedCause = Object.assign(
    new Error('connect ECONNREFUSED 127.0.0.1:3001'),
    { code: 'ECONNREFUSED' },
  )
  await assert.rejects(
    verifyPerformanceApiBackend({
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: refusedCause })
      },
    }),
    (error) => {
      assert.match(error.message, /connection refused/)
      assert.match(error.message, /TypeError: fetch failed/)
      assert.match(error.message, /ECONNREFUSED/)
      return true
    },
  )

  const timeout = Object.assign(
    new Error('The operation was aborted due to timeout. Bearer private-token'),
    { name: 'TimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
  )
  await assert.rejects(
    verifyPerformanceApiBackend({ fetchImpl: async () => { throw timeout } }),
    (error) => {
      assert.match(error.message, /request timed out/)
      assert.match(error.message, /TimeoutError/)
      assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/)
      assert.equal(error.message.includes('private-token'), false)
      return true
    },
  )
})

test('HTTP 503 reports the health route emulator-isolation failure safely', async () => {
  await assert.rejects(
    verifyPerformanceApiBackend({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({
          success: false,
          performanceMode: false,
          emulatorVerified: false,
          message: 'Performance environment safety checks failed.',
          credential: 'must-not-appear',
        }),
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 503 Service Unavailable/)
      assert.match(error.message, /emulator-isolation checks also failed/)
      assert.match(error.message, /Performance environment safety checks failed/)
      assert.equal(error.message.includes('must-not-appear'), false)
      return true
    },
  )
})
