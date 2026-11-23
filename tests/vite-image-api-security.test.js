import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createProtectedLocalHandler } from '../server/localApiSecurity.js'
import { deleteTelegramSchema } from '../server/validation.js'

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

function rejectingVerifier(statusCode, message) {
  return async (req, res) => {
    void req
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ success: false, message }))
    return null
  }
}

test('development upload rejects unauthenticated requests before routing', async () => {
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: rejectingVerifier(401, 'Unauthorized: Missing token'),
    limiter: () => true,
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(delegated, false)
})

test('development upload rejects non-admin requests before routing', async () => {
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: rejectingVerifier(401, 'Unauthorized: Admin access required'),
    limiter: () => true,
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { authorization: 'Bearer non-admin' } }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(delegated, false)
})

test('development deletion rejects unauthenticated requests before routing', async () => {
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: rejectingVerifier(401, 'Unauthorized: Missing token'),
    limiter: () => true,
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(delegated, false)
})

test('development deletion rejects non-admin requests before routing', async () => {
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: rejectingVerifier(401, 'Unauthorized: Admin access required'),
    limiter: () => true,
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { authorization: 'Bearer non-admin' } }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(delegated, false)
})

test('authorized admin upload and deletion routes reach their delegates', async () => {
  for (const method of ['upload', 'delete']) {
    let delegated = false
    const handler = createProtectedLocalHandler({
      verifyAdmin: async (req, res) => {
        void req
        void res
        return { uid: 'admin-uid', email: 'admin@example.com' }
      },
      limiter: (req, res) => {
        void req
        res.statusCode = 200
        return true
      },
      missingCredentialsMessage: 'Server configuration error',
      hasRequiredCredentials: () => true,
      delegate: async () => {
        delegated = true
        return { success: true, method }
      },
    })
    const res = createResponse()

    const result = await handler({ method: 'POST', headers: { authorization: 'Bearer admin' } }, res)

    assert.equal(delegated, true)
    assert.equal(result.method, method)
  }
})

test('protected mutation routes apply rate limiting after authorization', async () => {
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: async () => ({ uid: 'admin-uid' }),
    limiter: (req, res) => {
      void req
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: false, message: 'Too many requests, slow down.' }))
      return false
    },
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { authorization: 'Bearer admin' } }, res)

  assert.equal(res.statusCode, 429)
  assert.equal(delegated, false)
})

test('GET, PUT, PATCH and DELETE are rejected before authentication', async () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    let authenticated = false
    let limited = false
    let delegated = false
    const handler = createProtectedLocalHandler({
      verifyAdmin: async () => {
        authenticated = true
        return { uid: 'admin-uid' }
      },
      limiter: () => {
        limited = true
        return true
      },
      missingCredentialsMessage: 'Server configuration error',
      hasRequiredCredentials: () => true,
      delegate: async () => {
        delegated = true
      },
    })
    const res = createResponse()

    await handler({ method, headers: {} }, res)

    assert.equal(res.statusCode, 405)
    assert.equal(res.headers.allow, 'POST')
    assert.equal(authenticated, false)
    assert.equal(limited, false)
    assert.equal(delegated, false)
  }
})

test('POST continues through authentication', async () => {
  let authenticated = false
  let limited = false
  let delegated = false
  const handler = createProtectedLocalHandler({
    verifyAdmin: async () => {
      authenticated = true
      return { uid: 'admin-uid' }
    },
    limiter: () => {
      limited = true
      return true
    },
    missingCredentialsMessage: 'Server configuration error',
    hasRequiredCredentials: () => true,
    delegate: async () => {
      delegated = true
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { authorization: 'Bearer admin' } }, res)

  assert.equal(authenticated, true)
  assert.equal(limited, true)
  assert.equal(delegated, true)
})

test('strict Telegram deletion schema rejects an empty deletion body', () => {
  assert.equal(deleteTelegramSchema.safeParse({}).success, false)
})

test('strict Telegram deletion schema rejects a missing items field', () => {
  assert.equal(deleteTelegramSchema.safeParse({ unexpected: 'value' }).success, false)
})

test('strict Telegram deletion schema rejects an empty items array', () => {
  assert.equal(deleteTelegramSchema.safeParse({ items: [] }).success, false)
})

test('strict Telegram deletion schema rejects items without a message ID', () => {
  assert.equal(deleteTelegramSchema.safeParse({ items: [{}] }).success, false)
  assert.equal(deleteTelegramSchema.safeParse({ items: [{ chat_id: '123' }] }).success, false)
})

test('strict Telegram deletion schema accepts existing valid formats', () => {
  assert.equal(deleteTelegramSchema.safeParse({
    items: [{ message_id: 123, chat_id: '-100123' }],
  }).success, true)
  assert.equal(deleteTelegramSchema.safeParse({
    items: [{ telegram_message_id: '123', telegram_chat_id: '-100123' }],
  }).success, true)
})

test('Vite config keeps image retrieval public and mutation handlers protected', () => {
  const viteConfig = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8')
  assert.match(viteConfig, /createProtectedLocalHandler\(\{/)
  assert.match(viteConfig, /server\.middlewares\.use\('\/api\/upload-image', uploadHandler\)/)
  assert.match(viteConfig, /server\.middlewares\.use\('\/api\/delete-telegram-media', deleteHandler\)/)
  assert.match(viteConfig, /server\.middlewares\.use\('\/api\/image', proxyHandler\)/)
  assert.doesNotMatch(viteConfig, /server\.middlewares\.use\('\/api\/upload-image', handler\)/)
})
