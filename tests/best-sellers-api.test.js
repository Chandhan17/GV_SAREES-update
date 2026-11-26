import assert from 'node:assert/strict'
import test from 'node:test'
import handler from '../api/best-sellers.js'

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}

test('public endpoint returns only the ranked product IDs and uses cache headers', async () => {
  const response = createResponse()
  await handler({ method: 'GET' }, response, {
    getProductIds: async () => ['product-a', 'product-b'],
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { productIds: ['product-a', 'product-b'] })
  assert.match(response.headers['Cache-Control'], /s-maxage=300/)
})

test('local performance responses expose timing headers without changing the body', async () => {
  const response = createResponse()
  await handler({ method: 'GET' }, response, {
    env: {
      APP_MODE: 'performance',
      TELEGRAM_TEST_MODE: '1',
      FIREBASE_PROJECT_ID: 'demo-gv-sarees',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      NODE_ENV: 'development',
      VERCEL_ENV: 'development',
    },
    getProductIds: async ({ onTiming }) => {
      onTiming({ name: 'cache', durationMs: 0.25, description: 'hit' })
      onTiming({ name: 'recent_orders_query', durationMs: 1.75 })
      return ['product-a']
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { productIds: ['product-a'] })
  assert.match(response.headers['Server-Timing'], /handler-entry;desc="[^"]+"/)
  assert.match(response.headers['Server-Timing'], /cache;dur=0\.250;desc="hit"/)
  assert.match(response.headers['Server-Timing'], /recent_orders_query;dur=1\.750/)
  assert.match(response.headers['Server-Timing'], /handler-total;dur=/)
  assert.equal(response.headers['Server-Timing'].includes('product-a'), false)
})

test('local Vercel performance responses identify the actual Vercel runtime', async () => {
  const response = createResponse()
  await handler({ method: 'GET' }, response, {
    env: {
      APP_MODE: 'performance',
      TELEGRAM_TEST_MODE: '1',
      FIREBASE_PROJECT_ID: 'demo-gv-sarees',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      GV_PERFORMANCE_API_RUNTIME: 'vercel',
      VERCEL: '1',
      NODE_ENV: 'development',
      VERCEL_ENV: 'development',
    },
    getProductIds: async () => [],
  })

  assert.equal(response.headers['x-performance-api-runtime'], 'vercel')
  assert.deepEqual(response.body, { productIds: [] })
})

test('production responses do not expose internal timing headers or callbacks', async () => {
  const response = createResponse()
  await handler({ method: 'GET' }, response, {
    env: {
      APP_MODE: 'production',
      TELEGRAM_TEST_MODE: '1',
      FIREBASE_PROJECT_ID: 'demo-gv-sarees',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
    },
    getProductIds: async (options) => {
      assert.equal(options, undefined)
      return ['product-a']
    },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Server-Timing'], undefined)
  assert.equal(response.headers['x-performance-api-runtime'], undefined)
  assert.deepEqual(response.body, { productIds: ['product-a'] })
})

test('endpoint rejects unsupported methods', async () => {
  const response = createResponse()
  await handler({ method: 'POST' }, response, {
    getProductIds: async () => [],
  })

  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'GET')
})

test('aggregation errors return a sanitized error and disable response caching', async () => {
  const response = createResponse()
  const originalError = console.error
  console.error = () => {}
  try {
    await handler({ method: 'GET' }, response, {
      getProductIds: async () => {
        throw new Error('private database detail')
      },
    })
  } finally {
    console.error = originalError
  }

  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.body, {
    success: false,
    message: 'Unable to load best sellers.',
  })
  assert.equal(response.headers['Cache-Control'], 'no-store')
})
