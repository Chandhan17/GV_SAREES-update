import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'
import {
  PERFORMANCE_API_ROUTES,
  startPersistentPerformanceApi,
} from '../scripts/performanceApiServer.mjs'
import {
  PERFORMANCE_API_RUNTIME_ENV,
  PERFORMANCE_API_RUNTIME_HEADER,
  PERFORMANCE_API_STARTUP_HEADER,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
} from '../server/performanceSafety.js'

function createEnv(overrides = {}) {
  return {
    APP_MODE: 'performance',
    [PERFORMANCE_API_RUNTIME_ENV]: 'persistent',
    FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
    FIRESTORE_EMULATOR_HOST: PERFORMANCE_FIRESTORE_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    ...overrides,
  }
}

function createHandlers({ bestSellers, health } = {}) {
  return new Map([
    ['/api/best-sellers', bestSellers || ((_req, res) => (
      res.status(200).json({ productIds: ['test-only'] })
    ))],
    ['/api/test', health || ((_req, res) => (
      res.status(200).json({
        performanceMode: true,
        projectId: PERFORMANCE_PROJECT_ID,
        emulatorVerified: true,
      })
    ))],
  ])
}

async function startTestRuntime(options = {}) {
  return startPersistentPerformanceApi({
    env: createEnv(),
    assertConfiguration: () => true,
    verifyEmulator: async ({ projectId, emulatorHost }) => {
      assert.equal(projectId, PERFORMANCE_PROJECT_ID)
      assert.equal(emulatorHost, PERFORMANCE_FIRESTORE_HOST)
    },
    loadHandlers: async () => createHandlers(options),
    port: 0,
    ...options.runtimeOptions,
  })
}

function sendRequest({ port, path, method = 'GET', host, body }) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        Host: host || `127.0.0.1:${port}`,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolveResponse({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', rejectResponse)
    if (body) request.write(body)
    request.end()
  })
}

test('emulator safety verification completes before handler import and socket bind', async () => {
  const steps = []
  let boundHost
  const runtime = await startPersistentPerformanceApi({
    env: createEnv(),
    root: 'test-root',
    port: 0,
    assertConfiguration: (env, root) => {
      steps.push('configuration')
      assert.equal(env.APP_MODE, 'performance')
      assert.equal(root, 'test-root')
    },
    verifyEmulator: async (target) => {
      steps.push('emulator')
      assert.deepEqual(target, {
        projectId: PERFORMANCE_PROJECT_ID,
        emulatorHost: PERFORMANCE_FIRESTORE_HOST,
      })
    },
    loadHandlers: async () => {
      steps.push('import')
      return createHandlers()
    },
    createHttpServer: (listener) => {
      const server = createServer(listener)
      const listen = server.listen.bind(server)
      server.listen = (...args) => {
        steps.push('listen')
        boundHost = args[1]
        return listen(...args)
      }
      return server
    },
  })

  try {
    assert.deepEqual(steps, ['configuration', 'emulator', 'import', 'listen'])
    assert.equal(boundHost, '127.0.0.1')
  } finally {
    await runtime.close()
  }
})

test('unsafe config or emulator disconnection blocks handler import and listening', async () => {
  let imports = 0
  let serverCreated = false
  const baseOptions = {
    env: createEnv(),
    port: 0,
    loadHandlers: async () => {
      imports += 1
      return createHandlers()
    },
    createHttpServer: () => {
      serverCreated = true
      throw new Error('must not bind')
    },
  }

  await assert.rejects(startPersistentPerformanceApi({
    ...baseOptions,
    env: createEnv({ FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }),
    assertConfiguration: () => true,
  }), /demo Firebase project and configured local emulators/)
  await assert.rejects(startPersistentPerformanceApi({
    ...baseOptions,
    env: createEnv({ FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443' }),
    assertConfiguration: () => true,
  }), /configured local emulators/)
  await assert.rejects(startPersistentPerformanceApi({
    ...baseOptions,
    env: createEnv({ GV_PERFORMANCE_API_RUNTIME: 'vercel' }),
  }), /not explicitly selected/)
  await assert.rejects(startPersistentPerformanceApi({
    ...baseOptions,
    assertConfiguration: () => { throw new Error('performance mode missing') },
  }), /performance mode missing/)
  await assert.rejects(startPersistentPerformanceApi({
    ...baseOptions,
    assertConfiguration: () => true,
    verifyEmulator: async () => { throw new Error('emulator disconnected') },
  }), /emulator disconnected/)
  assert.equal(imports, 0)
  assert.equal(serverCreated, false)
})

test('runtime serves only exact GET routes and preserves handler responses', async (t) => {
  let bestSellerCalls = 0
  let healthCalls = 0
  const runtime = await startTestRuntime({
    bestSellers: (_req, res) => {
      bestSellerCalls += 1
      res.setHeader('Cache-Control', 'no-store')
      res.status(202).json({ productIds: ['test-only'] })
    },
    health: (_req, res) => {
      healthCalls += 1
      res.status(200).json({ success: true })
    },
  })
  t.after(() => runtime.close())

  const allowed = await sendRequest({
    port: runtime.port,
    path: '/api/best-sellers',
  })
  assert.equal(allowed.statusCode, 202)
  assert.equal(allowed.headers['cache-control'], 'no-store')
  assert.equal(allowed.headers[PERFORMANCE_API_RUNTIME_HEADER], 'persistent')
  assert.equal(Number(allowed.headers[PERFORMANCE_API_STARTUP_HEADER]) >= 0, true)
  assert.deepEqual(JSON.parse(allowed.body), { productIds: ['test-only'] })

  const incorrectHost = await sendRequest({
    port: runtime.port,
    path: '/api/best-sellers',
    host: 'localhost',
  })
  assert.equal(incorrectHost.statusCode, 421)

  const health = await sendRequest({ port: runtime.port, path: '/api/test' })
  assert.equal(health.statusCode, 200)
  assert.equal(health.headers[PERFORMANCE_API_RUNTIME_HEADER], 'persistent')
  assert.deepEqual(JSON.parse(health.body), { success: true })

  const post = await sendRequest({
    port: runtime.port,
    path: '/api/best-sellers',
    method: 'POST',
  })
  assert.equal(post.statusCode, 405)
  assert.equal(post.headers.allow, 'GET')

  const getWithBody = await sendRequest({
    port: runtime.port,
    path: '/api/best-sellers',
    body: 'unexpected',
  })
  assert.equal(getWithBody.statusCode, 400)

  for (const path of [
    '/api/reservations/create',
    '/api/razorpay/create-order',
    '/api/razorpay/webhook',
    '/api/upload-image',
    '/api/best-sellers?mutate=true',
    '/api/%62est-sellers',
  ]) {
    const rejected = await sendRequest({ port: runtime.port, path })
    assert.equal(rejected.statusCode, 404, path)
  }
  assert.equal(bestSellerCalls, 1)
  assert.equal(healthCalls, 1)
  assert.deepEqual(PERFORMANCE_API_ROUTES, ['/api/best-sellers', '/api/test'])
})

test('persistent runtime reuses one imported handler instance for repeated requests', async (t) => {
  let importCount = 0
  let invocationCount = 0
  const handlers = createHandlers({
    bestSellers: (_req, res) => {
      invocationCount += 1
      res.status(200).json({ invocationCount })
    },
  })
  const runtime = await startPersistentPerformanceApi({
    env: createEnv(),
    port: 0,
    assertConfiguration: () => true,
    verifyEmulator: async () => true,
    loadHandlers: async () => {
      importCount += 1
      return handlers
    },
  })
  t.after(() => runtime.close())

  const first = await sendRequest({ port: runtime.port, path: '/api/best-sellers' })
  const second = await sendRequest({ port: runtime.port, path: '/api/best-sellers' })
  assert.equal(importCount, 1)
  assert.equal(invocationCount, 2)
  assert.equal(JSON.parse(first.body).invocationCount, 1)
  assert.equal(JSON.parse(second.body).invocationCount, 2)
})

test('handler exceptions produce a generic sanitized error response', async (t) => {
  const runtime = await startTestRuntime({
    bestSellers: () => {
      throw new Error('token=private-token and customer@example.test')
    },
  })
  t.after(() => runtime.close())

  const result = await sendRequest({ port: runtime.port, path: '/api/best-sellers' })
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.includes('private-token'), false)
  assert.equal(result.body.includes('customer@example.test'), false)
  assert.deepEqual(JSON.parse(result.body), {
    success: false,
    message: 'Unable to process the local performance API request.',
  })
})

test('occupied API port fails clearly without affecting its current listener', async (t) => {
  const occupiedServer = createServer()
  await new Promise((resolveListen, rejectListen) => {
    occupiedServer.once('error', rejectListen)
    occupiedServer.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => new Promise((resolveClose) => occupiedServer.close(resolveClose)))

  const port = occupiedServer.address().port
  await assert.rejects(startPersistentPerformanceApi({
    env: createEnv(),
    port,
    assertConfiguration: () => true,
    verifyEmulator: async () => true,
    loadHandlers: async () => createHandlers(),
  }), /cannot bind to 127\.0\.0\.1:\d+; the port is occupied/)
  assert.notEqual(occupiedServer.listening, false)
})

test('graceful shutdown stops accepting requests and drains the active handler', async () => {
  let enteredHandler
  const handlerStarted = new Promise((resolveStarted) => {
    enteredHandler = resolveStarted
  })
  let finishHandler
  const finish = new Promise((resolveFinish) => {
    finishHandler = resolveFinish
  })
  const runtime = await startTestRuntime({
    bestSellers: async (_req, res) => {
      enteredHandler()
      await finish
      res.status(200).json({ productIds: [] })
    },
  })

  const activeRequest = sendRequest({
    port: runtime.port,
    path: '/api/best-sellers',
  })
  await handlerStarted
  let closed = false
  const closing = runtime.close().then(() => { closed = true })
  await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  assert.equal(closed, false)
  await assert.rejects(
    sendRequest({ port: runtime.port, path: '/api/test' }),
    /ECONNREFUSED/,
  )

  finishHandler()
  assert.equal((await activeRequest).statusCode, 200)
  await closing
  assert.equal(closed, true)
})
