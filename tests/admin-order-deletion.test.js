import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import handler from '../api/admin/orders.js'

function createMockFirestore(seed = {}) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [
      name,
      new Map(Object.entries(documents).map(([id, value]) => [id, structuredClone(value)])),
    ]),
  )
  let transactionCount = 0
  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const createRef = (name, id) => ({ collectionName: name, id })
  const getSnapshot = (ref) => {
    const value = getCollection(ref.collectionName).get(ref.id)
    return { exists: value !== undefined, data: () => value && structuredClone(value) }
  }

  return {
    collection(name) {
      return { doc(id) { return createRef(name, id) } }
    },
    async runTransaction(work) {
      transactionCount += 1
      const writes = []
      const result = await work({
        async get(ref) { return getSnapshot(ref) },
        update(ref, patch) { writes.push({ ref, patch }) },
      })
      for (const { ref, patch } of writes) {
        const collection = getCollection(ref.collectionName)
        const current = collection.get(ref.id)
        if (!current) throw new Error('Missing document during update')
        collection.set(ref.id, { ...current, ...patch })
      }
      return result
    },
    get(name, id) {
      const value = getCollection(name).get(id)
      return value && structuredClone(value)
    },
    get transactionCount() { return transactionCount },
  }
}

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end(body) { this.body = JSON.parse(body); return this },
  }
}

const authAdmin = async () => ({ uid: 'admin-1' })
const timestamp = { now: () => new Date('2026-11-24T12:00:00.000Z') }
const settledFailedOrder = {
  orderStatus: 'initiated',
  paymentMethod: 'razorpay',
  paymentStatus: 'failed',
  paymentAttempts: { attempt1: { status: 'failed' } },
  reservationStatus: 'released',
  stockReserved: false,
}

async function postDelete(firestore, orderIds, authenticateAdmin = authAdmin) {
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body: { action: 'delete', orderIds },
  }, response, { firestore, authenticateAdmin, timestamp })
  return response
}

test('authorized admin can remove one terminal order from the active list while preserving its audit record', async () => {
  const financialOrder = {
    orderStatus: 'delivered',
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
    razorpayPaymentId: 'pay-123',
    paymentAmountPaise: 250000,
    refundRequired: true,
    refundStatus: 'processed',
    refundId: 'rfnd-123',
    refundAmountPaise: 250000,
    paymentAttempts: { attempt1: { status: 'captured', paymentId: 'pay-123' } },
    reservationStatus: 'converted',
    stockDeducted: true,
    productId: 'product-1',
  }
  const firestore = createMockFirestore({
    orders: { 'order-1': financialOrder },
    products: { 'product-1': { totalStock: 8, reservedStock: 0 } },
    inventoryHistory: { history1: { orderId: 'order-1', quantityChanged: -2 } },
    reservationTokens: { reservation1: { tokenHash: 'kept' } },
    reservationRequests: { request1: { orderId: 'order-1' } },
    razorpayWebhookEvents: { event1: { orderId: 'order-1', outcome: 'captured' } },
  })

  const response = await postDelete(firestore, ['order-1'])

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.succeeded, ['order-1'])
  assert.equal(firestore.get('orders', 'order-1').deleted, true)
  assert.equal(firestore.get('orders', 'order-1').deletedBy, 'admin-1')
  assert.equal(firestore.get('orders', 'order-1').deletionRetention, 'financial_audit')
  assert.equal(firestore.get('orders', 'order-1').archived, true)
  assert.deepEqual(firestore.get('orders', 'order-1').paymentAttempts, financialOrder.paymentAttempts)
  assert.equal(firestore.get('orders', 'order-1').refundId, 'rfnd-123')
  assert.equal(firestore.get('orders', 'order-1').refundAmountPaise, 250000)
  assert.deepEqual(firestore.get('products', 'product-1'), { totalStock: 8, reservedStock: 0 })
  assert.deepEqual(firestore.get('inventoryHistory', 'history1'), { orderId: 'order-1', quantityChanged: -2 })
  assert.equal(firestore.get('reservationTokens', 'reservation1').tokenHash, 'kept')
  assert.equal(firestore.get('reservationRequests', 'request1').orderId, 'order-1')
  assert.equal(firestore.get('razorpayWebhookEvents', 'event1').outcome, 'captured')
})

test('admin can bulk remove multiple eligible orders using bounded per-order transactions', async () => {
  const firestore = createMockFirestore({
    orders: {
      'order-1': { ...settledFailedOrder },
      'order-2': { ...settledFailedOrder, orderStatus: 'cancelled' },
    },
  })

  const response = await postDelete(firestore, ['order-1', 'order-2'])

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.results.length, 2)
  assert.deepEqual(response.body.succeeded, ['order-1', 'order-2'])
  assert.equal(firestore.transactionCount, 2)
})

test('non-admin users cannot delete orders', async () => {
  const firestore = createMockFirestore({ orders: { 'order-1': settledFailedOrder } })
  const response = await postDelete(firestore, ['order-1'], async (_req, res) => {
    res.status(401).json({ message: 'Unauthorized' })
    return null
  })
  assert.equal(response.statusCode, 401)
  assert.equal(firestore.transactionCount, 0)
  assert.equal(firestore.get('orders', 'order-1').archived, undefined)
})

test('invalid, duplicate, and oversized order ID requests are rejected', async () => {
  const firestore = createMockFirestore({ orders: { 'order-1': settledFailedOrder } })
  for (const orderIds of [['../order-1'], ['order-1', 'order-1'], Array(101).fill('order-1')]) {
    const response = await postDelete(firestore, orderIds)
    assert.equal(response.statusCode, 400)
  }
  assert.equal(firestore.transactionCount, 0)
})

test('active holds, unresolved payment/refund, and unfinished paid fulfillment are rejected with partial results', async () => {
  const firestore = createMockFirestore({
    orders: {
      eligible: { ...settledFailedOrder },
      held: { ...settledFailedOrder, reservationStatus: 'active', stockReserved: true },
      pending: { ...settledFailedOrder, paymentStatus: 'pending', paymentAttempts: { attempt1: { status: 'pending' } } },
      nestedPending: {
        ...settledFailedOrder,
        paymentAttempts: {
          attempt1: {
            status: 'failed',
            payments: { 'pay-pending': { status: 'authorized' } },
          },
        },
      },
      refund: {
        orderStatus: 'cancelled',
        paymentStatus: 'captured',
        refundRequired: true,
        refundStatus: 'failed',
      },
      fulfilling: {
        orderStatus: 'processing',
        paymentStatus: 'captured',
        razorpayPaymentId: 'pay-1',
        reservationStatus: 'converted',
      },
    },
  })

  const response = await postDelete(firestore, ['eligible', 'held', 'pending', 'nestedPending', 'refund', 'fulfilling'])

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.succeeded, ['eligible'])
  assert.equal(response.body.failed.length, 5)
  assert.equal(firestore.get('orders', 'held').archived, undefined)
  assert.equal(firestore.get('orders', 'pending').archived, undefined)
  assert.equal(firestore.get('orders', 'nestedPending').archived, undefined)
  assert.equal(firestore.get('orders', 'refund').archived, undefined)
  assert.equal(firestore.get('orders', 'fulfilling').archived, undefined)
})

test('a document-level failure is reported without hiding other successful deletions', async () => {
  const firestore = createMockFirestore({
    orders: {
      'order-1': { ...settledFailedOrder },
      'order-2': { ...settledFailedOrder },
    },
  })
  const originalRunTransaction = firestore.runTransaction.bind(firestore)
  let shouldFail = true
  firestore.runTransaction = async (work) => {
    if (shouldFail) {
      shouldFail = false
      throw new Error('simulated transaction failure')
    }
    return originalRunTransaction(work)
  }

  const response = await postDelete(firestore, ['order-1', 'order-2'])

  assert.deepEqual(response.body.succeeded, ['order-2'])
  assert.equal(response.body.failed[0].orderId, 'order-1')
  assert.equal(response.body.failed[0].code, 'ORDER_DELETE_FAILED')
  assert.equal(firestore.get('orders', 'order-1').archived, undefined)
  assert.equal(firestore.get('orders', 'order-2').archived, true)
})

test('admin counts and recent-order lists exclude retained deleted records', () => {
  const dashboard = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  assert.match(dashboard, /const activeOrders = orders\.filter\(\(order\) => !order\.archived\)/)
  assert.match(dashboard, /activeOrders\.slice\(0, 5\)/)
})
