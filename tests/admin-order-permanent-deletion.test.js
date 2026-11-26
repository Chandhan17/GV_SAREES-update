import assert from 'node:assert/strict'
import test from 'node:test'
import handler from '../api/admin/orders.js'

function createMockFirestore(seed = {}, subcollections = {}) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [
      name,
      new Map(Object.entries(documents).map(([id, value]) => [id, structuredClone(value)])),
    ]),
  )
  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const snapshot = (ref) => {
    const data = getCollection(ref.collectionName).get(ref.id)
    return { exists: data !== undefined, ref, id: ref.id, data: () => data && structuredClone(data) }
  }
  const createRef = (collectionName, id) => ({
    collectionName,
    id,
    get: async function get() { return snapshot(this) },
    listCollections: async () => (subcollections[`${collectionName}/${id}`] || []).map((name) => ({ id: name })),
  })

  const firestore = {
    collection(name) {
      return {
        doc: (id) => createRef(name, id),
        where(field, operator, value) {
          return {
            isMockQuery: true,
            async get() {
              assert.equal(operator, '==')
              const docs = [...getCollection(name).entries()]
                .filter(([, document]) => document[field] === value)
                .map(([id]) => snapshot(createRef(name, id)))
              return { docs, empty: docs.length === 0 }
            },
          }
        },
      }
    },
    async runTransaction(work) {
      const writes = []
      const transaction = {
        get: async (ref) => (ref.isMockQuery ? ref.get() : snapshot(ref)),
        create: (ref, value) => writes.push({ type: 'create', ref, value: structuredClone(value) }),
        set: (ref, value) => writes.push({ type: 'set', ref, value: structuredClone(value) }),
        update: (ref, value) => writes.push({ type: 'update', ref, value: structuredClone(value) }),
        delete: (ref) => writes.push({ type: 'delete', ref }),
      }
      const result = await work(transaction)
      for (const write of writes) {
        const collection = getCollection(write.ref.collectionName)
        if (write.type === 'create' && collection.has(write.ref.id)) {
          throw new Error('Document already exists.')
        }
        if (write.type === 'update' && !collection.has(write.ref.id)) {
          throw new Error('Cannot update a missing document.')
        }
        if (write.type === 'delete') collection.delete(write.ref.id)
        if (write.type === 'update') {
          collection.set(write.ref.id, { ...collection.get(write.ref.id), ...write.value })
        }
        if (write.type === 'create' || write.type === 'set') collection.set(write.ref.id, write.value)
      }
      return result
    },
  }

  return {
    firestore,
    get(collectionName, id) {
      const value = getCollection(collectionName).get(id)
      return value && structuredClone(value)
    },
    set(collectionName, id, value) {
      getCollection(collectionName).set(id, structuredClone(value))
    },
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
  customer: { name: 'Customer PII', address: 'Private address', phone: '9999999999' },
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  orderStatus: 'initiated',
  paymentMethod: 'razorpay',
  paymentStatus: 'failed',
  paymentAttempts: {
    attempt1: {
      status: 'failed',
      amount: 125000,
      currency: 'INR',
      razorpayOrderId: 'order_abcd',
      paymentId: 'pay_abcd',
      payments: { pay_abcd: { status: 'failed' } },
    },
  },
  paymentIdempotencyKeyHash: 'hashed-idempotency-key',
  paymentAmountPaise: 125000,
  paymentCurrency: 'INR',
  razorpayOrderId: 'order_abcd',
  razorpayOrderIds: ['order_abcd'],
  razorpayPaymentId: 'pay_abcd',
  reservationId: 'reservation-1',
  reservationStatus: 'released',
  stockReserved: false,
  inventoryOwnershipStatus: 'released',
  productId: 'product-1',
  productName: 'Silk Saree',
  reservedQuantity: 1,
  price: 1250,
  totalAmount: 1250,
}

function deliveredOrder() {
  return {
    ...structuredClone(settledFailedOrder),
    orderStatus: 'delivered',
    paymentStatus: 'captured',
    paymentAttempts: {
      attempt1: {
        ...structuredClone(settledFailedOrder.paymentAttempts.attempt1),
        status: 'captured',
        payments: { pay_abcd: { status: 'captured' } },
      },
    },
    reservationStatus: 'converted',
    stockReserved: false,
    stockDeducted: true,
    inventoryOwnershipStatus: 'consumed',
  }
}

async function post(firestore, body, authenticateAdmin = authAdmin) {
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body,
  }, response, { firestore, authenticateAdmin, timestamp })
  return response
}

const permanentDelete = (orderIds, backupDisposition = 'skipped') => ({
  action: 'permanent-delete',
  orderIds,
  backupDisposition,
})

test('permanently deletes a settled failed order and retains a minimal financial audit', async () => {
  const mock = createMockFirestore({
    orders: { failed: settledFailedOrder },
    orderDeletionAudits: {},
    products: { 'product-1': { totalStock: 8, reservedStock: 0 } },
    customers: { customer1: { name: 'Unrelated customer' } },
    inventoryHistory: {
      history1: {
        orderId: 'failed',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'release',
        quantityChanged: -1,
      },
    },
    reservationTokens: { 'reservation-1': { tokenHash: 'kept' } },
    reservationRequests: { request1: { orderId: 'failed' } },
    razorpayWebhookEvents: { event1: { razorpayOrderId: 'order_abcd', outcome: 'failed' } },
  })

  const response = await post(mock.firestore, permanentDelete(['failed'], 'exported'))
  const audit = mock.get('orderDeletionAudits', 'failed')

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.permanentlyDeletedCount, 1)
  assert.equal(mock.get('orders', 'failed'), undefined)
  assert.equal(audit.schemaVersion, 1)
  assert.equal(audit.deletedBy, 'admin-1')
  assert.equal(audit.financialRecord.paymentStatus, 'failed')
  assert.equal(audit.financialRecord.paymentAttempts.attempt1.paymentId, 'pay_abcd')
  assert.equal(audit.financialRecord.refundId, undefined)
  assert.equal(audit.customer, undefined)
  assert.equal(audit.financialRecord.customer, undefined)
  assert.equal(audit.financialRecord.paymentIdempotencyKeyHash, 'hashed-idempotency-key')
  assert.equal(response.body.results[0].relatedSubcollectionsRemoved, 0)
  assert.deepEqual(mock.get('products', 'product-1'), { totalStock: 8, reservedStock: 0 })
  assert.deepEqual(mock.get('customers', 'customer1'), { name: 'Unrelated customer' })
  assert.deepEqual(mock.get('inventoryHistory', 'history1'), {
    orderId: 'failed',
    reservationId: 'reservation-1',
    productId: 'product-1',
    actionType: 'release',
    quantityChanged: -1,
  })
  assert.equal(mock.get('reservationTokens', 'reservation-1').tokenHash, 'kept')
  assert.equal(mock.get('reservationRequests', 'request1').orderId, 'failed')
  assert.equal(mock.get('razorpayWebhookEvents', 'event1').outcome, 'failed')
})

test('permanently deletes a delivered paid order while retaining its financial references', async () => {
  const mock = createMockFirestore({
    orders: { delivered: deliveredOrder() },
    inventoryHistory: {
      history1: {
        orderId: 'delivered',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'convert',
      },
    },
  })
  const response = await post(mock.firestore, permanentDelete(['delivered']))
  const audit = mock.get('orderDeletionAudits', 'delivered')

  assert.deepEqual(response.body.succeeded, ['delivered'])
  assert.equal(mock.get('orders', 'delivered'), undefined)
  assert.equal(audit.financialRecord.orderStatus, 'delivered')
  assert.equal(audit.financialRecord.paymentAmountPaise, 125000)
  assert.equal(audit.financialRecord.razorpayPaymentId, 'pay_abcd')
})

test('bulk permanent deletion processes each eligible order independently', async () => {
  const mock = createMockFirestore({
    orders: { failed: settledFailedOrder, delivered: deliveredOrder() },
    inventoryHistory: {
      history1: {
        orderId: 'failed',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'release',
      },
      history2: {
        orderId: 'delivered',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'convert',
      },
    },
  })
  const response = await post(mock.firestore, permanentDelete(['failed', 'delivered']))

  assert.equal(response.body.results.length, 2)
  assert.deepEqual(response.body.succeeded, ['failed', 'delivered'])
  assert.equal(response.body.rejectedCount, 0)
  assert.equal(mock.get('orders', 'failed'), undefined)
  assert.equal(mock.get('orders', 'delivered'), undefined)
})

test('bulk deletion reports a rejected order alongside successful removals', async () => {
  const mock = createMockFirestore({
    orders: {
      failed: settledFailedOrder,
      pending: { ...settledFailedOrder, paymentStatus: 'pending' },
    },
    inventoryHistory: {
      history1: {
        orderId: 'failed',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'release',
      },
    },
  })
  const response = await post(mock.firestore, permanentDelete(['failed', 'pending']))

  assert.deepEqual(response.body.succeeded, ['failed'])
  assert.equal(response.body.rejectedCount, 1)
  assert.equal(response.body.failed[0].orderId, 'pending')
  assert.equal(response.body.failed[0].code, 'PAYMENT_UNRESOLVED')
  assert.equal(mock.get('orders', 'failed'), undefined)
  assert.equal(mock.get('orders', 'pending').paymentStatus, 'pending')
})

test('permanent deletion fails closed when reservation inventory history is absent or inconsistent', async () => {
  const mock = createMockFirestore({
    orders: {
      missing: { ...settledFailedOrder },
      mismatched: { ...settledFailedOrder },
      incomplete: { ...settledFailedOrder },
    },
    inventoryHistory: {
      mismatchedHistory: {
        orderId: 'mismatched',
        reservationId: 'reservation-1',
        productId: 'another-product',
        actionType: 'release',
      },
      incompleteHistory: {
        orderId: 'incomplete',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'reserve',
      },
    },
  })
  const response = await post(mock.firestore, permanentDelete(['missing', 'mismatched', 'incomplete']))

  assert.deepEqual(response.body.failed.map(({ code }) => code), [
    'INVENTORY_RECONCILIATION_REQUIRED',
    'INVENTORY_RECONCILIATION_REQUIRED',
    'INVENTORY_RECONCILIATION_REQUIRED',
  ])
  for (const orderId of ['missing', 'mismatched', 'incomplete']) {
    assert.ok(mock.get('orders', orderId))
    assert.equal(mock.get('orderDeletionAudits', orderId), undefined)
  }
})

test('legacy orders without reservation IDs remain eligible when other checks pass', async () => {
  const legacyOrder = { ...settledFailedOrder }
  delete legacyOrder.reservationId
  const mock = createMockFirestore({ orders: { legacy: legacyOrder } })
  const response = await post(mock.firestore, permanentDelete(['legacy']))

  assert.deepEqual(response.body.succeeded, ['legacy'])
  assert.equal(mock.get('orders', 'legacy'), undefined)
})

test('unauthorized, malformed, duplicate, or unreviewed backup requests cannot delete orders', async () => {
  const mock = createMockFirestore({ orders: { failed: settledFailedOrder } })
  const unauthorized = await post(mock.firestore, permanentDelete(['failed']), async (_req, res) => {
    res.status(401).json({ message: 'Unauthorized' })
    return null
  })
  assert.equal(unauthorized.statusCode, 401)

  for (const body of [
    permanentDelete(['../failed']),
    permanentDelete(['failed', 'failed']),
    { action: 'permanent-delete', orderIds: ['failed'] },
  ]) {
    const response = await post(mock.firestore, body)
    assert.equal(response.statusCode, 400)
  }
  assert.equal(mock.get('orders', 'failed').paymentStatus, 'failed')
  assert.equal(mock.get('orderDeletionAudits', 'failed'), undefined)
})

test('pending payments, nested authorizations, refunds, inventory holds, fulfillment, and open issues are rejected', async () => {
  const orders = {
    pending: { ...settledFailedOrder, paymentStatus: 'pending', paymentAttempts: { attempt1: { status: 'pending' } } },
    nestedAuthorized: {
      ...settledFailedOrder,
      paymentAttempts: { attempt1: { status: 'failed', payments: { pay_abcd: { status: 'authorized' } } } },
    },
    refund: { ...settledFailedOrder, paymentStatus: 'captured', orderStatus: 'cancelled', refundRequired: true, refundStatus: 'failed' },
    held: { ...settledFailedOrder, reservationStatus: 'active', stockReserved: true, inventoryOwnershipStatus: 'held' },
    fulfilling: { ...deliveredOrder(), orderStatus: 'processing' },
    disputed: { ...settledFailedOrder, disputeStatus: 'under_review' },
    releasePending: { ...settledFailedOrder, inventoryOwnershipStatus: 'released_pending_verification' },
  }
  const mock = createMockFirestore({ orders })
  const response = await post(mock.firestore, permanentDelete(Object.keys(orders)))

  assert.equal(response.body.rejectedCount, Object.keys(orders).length)
  assert.deepEqual(response.body.failed.map(({ code }) => code), [
    'PAYMENT_UNRESOLVED',
    'PAYMENT_UNRESOLVED',
    'REFUND_UNRESOLVED',
    'ACTIVE_RESERVATION',
    'ORDER_NOT_TERMINAL',
    'ORDER_ISSUE_UNRESOLVED',
    'ACTIVE_RESERVATION',
  ])
  for (const orderId of Object.keys(orders)) {
    assert.ok(mock.get('orders', orderId))
    assert.equal(mock.get('orderDeletionAudits', orderId), undefined)
  }
})

test('orders with unknown subcollections are rejected without deleting any documents', async () => {
  const mock = createMockFirestore(
    { orders: { failed: settledFailedOrder } },
    { 'orders/failed': ['items'] },
  )
  const response = await post(mock.firestore, permanentDelete(['failed']))

  assert.equal(response.body.failed[0].code, 'ORDER_HAS_SUBCOLLECTIONS')
  assert.match(response.body.failed[0].message, /items/)
  assert.ok(mock.get('orders', 'failed'))
  assert.equal(mock.get('orderDeletionAudits', 'failed'), undefined)
})

test('eligibility is revalidated in the transaction and transaction failures are safely retryable', async () => {
  const mock = createMockFirestore({ orders: { failed: settledFailedOrder } })
  const originalTransaction = mock.firestore.runTransaction.bind(mock.firestore)
  let raced = false
  mock.firestore.runTransaction = async (work) => {
    if (!raced) {
      raced = true
      const current = mock.get('orders', 'failed')
      current.paymentStatus = 'pending'
      mock.set('orders', 'failed', current)
    }
    return originalTransaction(work)
  }
  const racedResponse = await post(mock.firestore, permanentDelete(['failed']))
  assert.equal(racedResponse.body.failed[0].code, 'PAYMENT_UNRESOLVED')
  assert.ok(mock.get('orders', 'failed'))

  const retryMock = createMockFirestore({
    orders: { failed: settledFailedOrder },
    inventoryHistory: {
      history1: {
        orderId: 'failed',
        reservationId: 'reservation-1',
        productId: 'product-1',
        actionType: 'release',
      },
    },
  })
  const retryTransaction = retryMock.firestore.runTransaction.bind(retryMock.firestore)
  let failOnce = true
  retryMock.firestore.runTransaction = async (work) => {
    if (failOnce) {
      failOnce = false
      throw new Error('temporary Firestore transaction failure')
    }
    return retryTransaction(work)
  }
  const failedResponse = await post(retryMock.firestore, permanentDelete(['failed']))
  assert.equal(failedResponse.body.failed[0].code, 'ORDER_DELETE_FAILED')
  assert.ok(retryMock.get('orders', 'failed'))

  const successfulRetry = await post(retryMock.firestore, permanentDelete(['failed']))
  assert.equal(successfulRetry.body.permanentlyDeletedCount, 1)
  const idempotentRetry = await post(retryMock.firestore, permanentDelete(['failed']))
  assert.equal(idempotentRetry.body.alreadyDeletedCount, 1)
})

test('the existing archive action still retains the order document', async () => {
  const mock = createMockFirestore({ orders: { failed: settledFailedOrder } })
  const response = await post(mock.firestore, { action: 'archive', orderId: 'failed' })

  assert.equal(response.body.archived, true)
  assert.equal(mock.get('orders', 'failed').archived, true)
  assert.equal(mock.get('orderDeletionAudits', 'failed'), undefined)
})
