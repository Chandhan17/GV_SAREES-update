import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  adjustInventory,
  convertInventory,
  normalizeInventory,
  releaseInventory,
  reserveInventory,
  setInventoryThreshold,
} from '../server/inventory.js'
import { isAuthorizedAdminRecord } from '../server/adminAuthorization.js'
import { processExpiryPages } from '../server/expiryCleanup.js'
import { cronSecretMatches } from '../server/cronAuth.js'
import { assertOrderCanArchive, validateOrderStatusTransition } from '../server/orderPolicy.js'
import {
  cancellationTokenMatches,
  hashCancellationToken,
  isReservationExpired,
  makeCancellationToken,
  reservationFingerprint,
} from '../server/reservationSecurity.js'
import { inventoryMigrationPatch } from '../scripts/migrateInventory.js'
import {
  adminOrderActionSchema,
  customerReservationCancellationSchema,
  inventoryAdjustmentSchema,
  reservationSchema,
} from '../server/validation.js'

const secret = 'a'.repeat(64)

test('legacy products without explicit stock are safely out of stock', () => {
  assert.deepEqual(normalizeInventory({}), {
    totalStock: 0,
    reservedStock: 0,
    availableStock: 0,
    inStock: false,
    lowStockThreshold: 2,
  })
})

test('reservation, conversion, and release preserve inventory equations', () => {
  const first = reserveInventory({ totalStock: 5, reservedStock: 0 }, 1)
  const second = reserveInventory({ totalStock: 5, reservedStock: first.reservedStock }, 2)
  assert.equal(second.availableStock, 2)
  assert.equal(second.reservedStock, 3)
  assert.throws(() => reserveInventory({ totalStock: 5, reservedStock: 3 }, 3), { code: 'INSUFFICIENT_STOCK' })
  const converted = convertInventory(second, 1)
  assert.deepEqual([converted.totalStock, converted.reservedStock, converted.availableStock], [4, 2, 2])
  const released = releaseInventory(second, 1)
  assert.deepEqual([released.totalStock, released.reservedStock, released.availableStock], [5, 2, 3])
  assert.throws(() => adjustInventory({ totalStock: 5, reservedStock: 3 }, -3), { code: 'RESERVED_STOCK_PROTECTED' })
})

test('admin product detail edits omit inventory fields and send the threshold through the inventory API', () => {
  const page = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  const payloadMatch = page.match(/const payload = \{([\s\S]*?)\n\s{6}\}/)
  assert.ok(payloadMatch)
  assert.match(payloadMatch[1], /name:/)
  assert.match(payloadMatch[1], /images:/)
  assert.doesNotMatch(payloadMatch[1], /totalStock|reservedStock|availableStock|inStock|lowStockThreshold/)
  assert.match(page, /await editProduct\(editingId, payload\)/)
  assert.match(page, /await adjustProductInventory\(\{[\s\S]*lowStockThreshold:/)
  assert.match(page, /lowStockThreshold: Math\.max\(0, Number\(form\.lowStockThreshold\) \|\| 0\)/)
})

test('threshold-only updates preserve normalized stock and reject invalid thresholds', () => {
  const product = { totalStock: 5, reservedStock: 2, lowStockThreshold: 2 }
  assert.deepEqual(setInventoryThreshold(product, 4), {
    totalStock: 5,
    reservedStock: 2,
    availableStock: 3,
    inStock: true,
    lowStockThreshold: 4,
  })
  assert.throws(() => setInventoryThreshold(product, -1), { code: 'INVALID_LOW_STOCK_THRESHOLD' })
  assert.throws(() => setInventoryThreshold(product, 1.5), { code: 'INVALID_LOW_STOCK_THRESHOLD' })
})

test('stock adjustment atomically applies an optional threshold while preserving reservation availability', () => {
  const updated = adjustInventory(
    { totalStock: 5, reservedStock: 2, lowStockThreshold: 2 },
    3,
    4,
  )
  assert.deepEqual(updated, {
    totalStock: 8,
    reservedStock: 2,
    availableStock: 6,
    inStock: true,
    lowStockThreshold: 4,
  })
  assert.equal(updated.availableStock, updated.totalStock - updated.reservedStock)
})

test('stock adjustment without a threshold preserves the existing threshold', () => {
  assert.deepEqual(adjustInventory(
    { totalStock: 5, reservedStock: 2, lowStockThreshold: 3 },
    1,
  ), {
    totalStock: 6,
    reservedStock: 2,
    availableStock: 4,
    inStock: true,
    lowStockThreshold: 3,
  })
})

test('inventory adjustment schema rejects negative and non-integer thresholds', () => {
  const base = {
    action: 'adjust',
    productId: 'p1',
    quantityChange: 1,
    reason: 'Admin adjustment',
  }
  assert.equal(inventoryAdjustmentSchema.safeParse({ ...base, lowStockThreshold: -1 }).success, false)
  assert.equal(inventoryAdjustmentSchema.safeParse({ ...base, lowStockThreshold: 1.5 }).success, false)
  assert.equal(inventoryAdjustmentSchema.safeParse({ ...base, lowStockThreshold: 4 }).success, true)
})

test('simultaneous final-piece attempts cannot both pass the same stock snapshot', () => {
  const first = reserveInventory({ totalStock: 1, reservedStock: 0 }, 1)
  assert.equal(first.availableStock, 0)
  assert.throws(() => reserveInventory({ totalStock: first.totalStock, reservedStock: first.reservedStock }, 1), { code: 'INSUFFICIENT_STOCK' })
})

test('reservation fingerprints are canonical and detect changed payloads', () => {
  const a = reservationFingerprint({
    productId: 'p1', quantity: 2, selectedSize: '5.5 m',
    customer: { name: ' Ada  Lovelace ', phone: '+91 98765-43210', address: '  Main   Road ' },
  })
  const b = reservationFingerprint({
    productId: 'p1', quantity: 2, selectedSize: '5.5 m',
    customer: { name: 'Ada Lovelace', phone: '919876543210', address: 'Main Road' },
  })
  assert.equal(a, b)
  assert.notEqual(a, reservationFingerprint({
    productId: 'p1', quantity: 1, selectedSize: '5.5 m',
    customer: { name: 'Ada Lovelace', phone: '919876543210', address: 'Main Road' },
  }))
})

test('cancellation tokens are reservation-bound and timing-safe hash matches reject invalid tokens', () => {
  const fingerprint = 'f'.repeat(64)
  const tokenA = makeCancellationToken(secret, 'reservation-a', fingerprint)
  const tokenB = makeCancellationToken(secret, 'reservation-b', fingerprint)
  assert.equal(cancellationTokenMatches(tokenA, hashCancellationToken(tokenA)), true)
  assert.equal(cancellationTokenMatches(tokenA, hashCancellationToken(tokenB)), false)
  assert.equal(cancellationTokenMatches('invalid', hashCancellationToken(tokenA)), false)
})

test('cancel endpoint schema requires a UUID and a 64-character token', () => {
  assert.equal(customerReservationCancellationSchema.safeParse({ reservationId: 'not-an-id', cancellationToken: 'x' }).success, false)
  assert.equal(customerReservationCancellationSchema.safeParse({
    reservationId: 'cc970f63-fbe7-46b3-bd65-bd623f25c039',
    cancellationToken: 'a'.repeat(64),
  }).success, true)
})

test('reservation request schema rejects unsafe idempotency key and browser price/status fields are ignored by its shape', () => {
  const valid = {
    productId: 'product1',
    quantity: 1,
    idempotencyKey: 'key_0123456789abcdef',
    customer: { name: 'A', phone: '12345', address: 'Somewhere' },
    price: 1,
    paymentStatus: 'paid',
  }
  const parsed = reservationSchema.safeParse(valid)
  assert.equal(parsed.success, true)
  assert.equal('price' in parsed.data, false)
  assert.equal('paymentStatus' in parsed.data, false)
  assert.equal(reservationSchema.safeParse({ ...valid, idempotencyKey: '../bad' }).success, false)
})

test('admin record authorization requires an existing explicit true record', () => {
  assert.equal(isAuthorizedAdminRecord({ exists: false, data: () => ({ isAdmin: true }) }), false)
  assert.equal(isAuthorizedAdminRecord({ exists: true, data: () => ({ isAdmin: false }) }), false)
  assert.equal(isAuthorizedAdminRecord({ exists: true, data: () => ({ isAdmin: true }) }), true)
})

test('cron authorization requires a long configured secret and compares exact values', () => {
  assert.equal(cronSecretMatches('', secret), false)
  assert.equal(cronSecretMatches(secret, 'wrong'), false)
  assert.equal(cronSecretMatches(secret, secret), true)
})

test('active reservation cannot be archived and reservation completion requires conversion', () => {
  assert.throws(() => assertOrderCanArchive({ reservationStatus: 'active' }), { code: 'ACTIVE_RESERVATION' })
  assert.doesNotThrow(() => assertOrderCanArchive({ reservationStatus: 'released' }))
  assert.throws(() => validateOrderStatusTransition({ reservationId: 'r1', reservationStatus: 'active' }, 'confirmed'), { code: 'RESERVATION_ACTION_REQUIRED' })
  assert.throws(() => validateOrderStatusTransition({ reservationId: 'r1', reservationStatus: 'active', orderStatus: 'initiated' }, 'completed'), { code: 'RESERVATION_NOT_CONVERTED' })
  assert.doesNotThrow(() => validateOrderStatusTransition({ reservationId: 'r1', reservationStatus: 'converted', orderStatus: 'confirmed' }, 'completed'))
})

test('expired reservations are recognized at the expiry boundary', () => {
  const expiry = new Date('2026-11-20T12:00:00Z')
  assert.equal(isReservationExpired(expiry, expiry.getTime()), true)
  assert.equal(isReservationExpired(expiry, expiry.getTime() - 1), false)
})

test('expiry cleanup paginates beyond 50 and reattempts failures without duplicate successful release', async () => {
  const records = Array.from({ length: 123 }, (_, id) => ({ id }))
  const released = new Set()
  let failedOnce = false
  const result = await processExpiryPages(
    async ({ cursor, limit }) => {
      const start = cursor ? cursor.id + 1 : 0
      return records.slice(start, start + limit)
    },
    async ({ id }) => {
      if (id === 20 && !failedOnce) {
        failedOnce = true
        throw new Error('temporary')
      }
      if (released.has(id)) return false
      released.add(id)
      return true
    },
    { pageSize: 50, maxPages: 10 },
  )
  assert.equal(result.processed, 123)
  assert.equal(result.failed, 1)
  assert.equal(result.released, 122)
  assert.equal(released.size, 122)
})

test('inventory migration patch is repeatable and preserves reserved stock without writing in dry-run helper', () => {
  const existing = { reservedStock: 2, lowStockThreshold: 3 }
  const first = inventoryMigrationPatch(existing, 5)
  assert.deepEqual(first.patch, {
    totalStock: 5,
    reservedStock: 2,
    availableStock: 3,
    inStock: true,
    lowStockThreshold: 3,
  })
  assert.equal(inventoryMigrationPatch(first.patch, 5).alreadyInitialized, true)
  assert.throws(() => inventoryMigrationPatch(existing, 1), /below the product reserved quantity/)
})

test('Firestore rules deny all direct order writes and constrain product updates to content fields', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
  assert.match(rules, /match \/orders\/\{id\}[\s\S]*allow create, update, delete: if false;/)
  assert.match(rules, /match \/products\/\{id\}[\s\S]*allow update: if false;/)
  assert.doesNotMatch(rules, /allow update: if isAdmin/)
})

test('Razorpay order creation endpoint is disabled pending a complete payment lifecycle', () => {
  const route = readFileSync(new URL('../api/razorpay/create-order.js', import.meta.url), 'utf8')
  assert.match(route, /410/)
  assert.doesNotMatch(route, /orders\.create/)
})

test('public order creation helper is removed and admin order operations use server API', () => {
  const service = readFileSync(new URL('../src/services/orderService.js', import.meta.url), 'utf8')
  assert.doesNotMatch(service, /export async function createOrder/)
  assert.match(service, /\/api\/admin\/orders/)
  assert.match(service, /action: 'archive'/)
})

test('reservation creation and cancellation remain connected to customer WhatsApp flow', () => {
  const modal = readFileSync(new URL('../src/components/QuickShopModal.jsx', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../src/services/reservationService.js', import.meta.url), 'utf8')
  assert.match(modal, /createWhatsAppReservation/)
  assert.match(modal, /openWhatsApp/)
  assert.match(modal, /rememberCustomerReservation/)
  assert.match(service, /\/api\/reservations\/cancel/)
})

test('admin order API schema admits only explicit status and archive actions', () => {
  assert.equal(adminOrderActionSchema.safeParse({ action: 'status', orderId: 'o1', orderStatus: 'confirmed' }).success, true)
  assert.equal(adminOrderActionSchema.safeParse({ action: 'status', orderId: 'o1', orderStatus: 'paid' }).success, false)
  assert.equal(adminOrderActionSchema.safeParse({ action: 'delete', orderId: 'o1' }).success, false)
})
