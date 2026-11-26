import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createApiProxyConfig } from '../server/apiProxyConfig.js'
import { PERFORMANCE_API_TARGET } from '../server/performanceSafety.js'
import statusHandler from '../api/reservations/status.js'
import cancelHandler from '../api/reservations/cancel.js'
import {
  getCustomerReservationCheckoutKey,
  getCustomerReservations,
  getCustomerReservationStatus,
  rememberCustomerReservation,
} from '../src/services/reservationService.js'

function installLocalStorage(t, initialEntries = []) {
  const entries = new Map(initialEntries)
  const storage = {
    get length() {
      return entries.size
    },
    key(index) {
      return [...entries.keys()][index] ?? null
    },
    getItem(key) {
      return entries.get(key) ?? null
    },
    setItem(key, value) {
      entries.set(key, String(value))
    },
    removeItem(key) {
      entries.delete(key)
    },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  return storage
}

function installFetch(t, implementation) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: implementation })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'fetch', previous)
    else delete globalThis.fetch
  })
}

const reservation = {
  reservationId: 'cc970f63-fbe7-46b3-bd65-bd623f25c039',
  cancellationToken: 'a'.repeat(64),
  expiresAt: '2026-11-23T12:00:00.000Z',
  productName: 'Silk Saree',
  reservedQuantity: 2,
}

test('saved order listing exposes display metadata but not the access token', (t) => {
  installLocalStorage(t)
  rememberCustomerReservation(reservation)

  assert.deepEqual(getCustomerReservations(), [{
    reservationId: reservation.reservationId,
    expiresAt: reservation.expiresAt,
    productName: reservation.productName,
    reservedQuantity: reservation.reservedQuantity,
    accessAvailable: true,
  }])
})

test('customer cancellation endpoint is disabled and leaves historical records intact', async () => {
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = JSON.parse(body) },
  }
  await cancelHandler({ method: 'POST' }, response)
  assert.equal(response.statusCode, 410)
  assert.match(response.body.message, /managed by the store/)
})

test('checkout idempotency key is retained with reservation access data', (t) => {
  installLocalStorage(t)
  rememberCustomerReservation(reservation, 'payment-attempt-key-001')
  rememberCustomerReservation(reservation)

  assert.equal(getCustomerReservationCheckoutKey(reservation.reservationId), 'payment-attempt-key-001')
})

test('customer status lookup authenticates with the saved token and returns backend status', async (t) => {
  installLocalStorage(t)
  rememberCustomerReservation(reservation)
  let request
  installFetch(t, async (...args) => {
    request = args
    return {
      ok: true,
      json: async () => ({ success: true, reservation: { reservationId: reservation.reservationId, status: 'confirmed' } }),
    }
  })

  const result = await getCustomerReservationStatus(reservation.reservationId)

  assert.equal(request[0], '/api/reservations/status')
  assert.equal(request[1].method, 'POST')
  assert.deepEqual(JSON.parse(request[1].body), {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
  })
  assert.equal(result.status, 'confirmed')
})

test('reservation status API forwards verified access details and returns only its status result', async () => {
  const reservationId = 'cc970f63-fbe7-46b3-bd65-bd623f25c039'
  const cancellationToken = 'a'.repeat(64)
  let lookup
  const response = {
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

  await statusHandler({
    method: 'POST',
    body: { reservationId, cancellationToken },
  }, response, {
    getStatus: async (...args) => {
      lookup = args
      return { reservationId, status: 'confirmed' }
    },
    rateLimit: () => true,
  })

  assert.deepEqual(lookup, [reservationId, cancellationToken])
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, {
    success: true,
    reservation: { reservationId, status: 'confirmed' },
  })
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
})

test('My Orders retains historical reservation routes and has no customer cancel action', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const config = readFileSync(new URL('../src/config/clientConfig.js', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/CustomerReservationsPage.jsx', import.meta.url), 'utf8')
  const statusRoute = readFileSync(new URL('../api/reservations/status.js', import.meta.url), 'utf8')

  assert.match(app, /path="\/orders"/)
  assert.match(app, /path="\/reservations".*Navigate to="\/orders"/)
  assert.match(config, /label: 'My Orders', to: '\/orders'/)
  assert.match(page, /My Orders/)
  assert.doesNotMatch(page, /cancelWhatsAppReservation|Cancel reservation/)
  assert.match(statusRoute, /getStatus\(parse\.data\.reservationId, parse\.data\.cancellationToken\)/)
  const performanceProxy = createApiProxyConfig(PERFORMANCE_API_TARGET)
  const developmentProxy = createApiProxyConfig('http://127.0.0.1:3000')
  for (const route of ['/api/reservations/create', '/api/reservations/status']) {
    assert.deepEqual(performanceProxy[route], {
      target: 'http://127.0.0.1:3001',
      changeOrigin: true,
    })
    assert.deepEqual(developmentProxy[route], {
      target: 'http://127.0.0.1:3000',
      changeOrigin: true,
    })
  }
})

test('My Orders renders every product and the combined amount for a multi-item reservation', () => {
  const page = readFileSync(new URL('../src/pages/CustomerReservationsPage.jsx', import.meta.url), 'utf8')
  assert.match(page, /reservation\.items\?\.length/)
  assert.match(page, /\.map\(\(item, index\) => \(/)
  assert.match(page, /Order total:/)
  assert.match(page, /formatStoreDateTime\(reservation\.createdAt\)/)
})
