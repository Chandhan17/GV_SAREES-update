import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cancelReservation,
  confirmReservation,
  createCheckoutReservation,
  expireReservation,
  getCustomerReservationStatus,
  releaseReservation,
  releaseReservationStockInTransaction,
  restockConvertedOrder,
} from '../server/reservationService.js'
import { reservationSchema } from '../server/validation.js'
import { createCheckoutReservation as createReservationRequest } from '../src/services/reservationService.js'

function createTimestamp(milliseconds) {
  return {
    toDate: () => new Date(milliseconds),
    toMillis: () => milliseconds,
    toISOString: () => new Date(milliseconds).toISOString(),
  }
}

const mockTimestamp = {
  now: () => createTimestamp(Date.now()),
  fromMillis: (milliseconds) => createTimestamp(milliseconds),
}

function createMockFirestore(seed = {}) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [name, new Map(
      Object.entries(documents).map(([id, value]) => [id, { ...value }]),
    )]),
  )
  let nextId = 0
  let transactionTail = Promise.resolve()

  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const createRef = (collectionName, id) => ({
    collectionName,
    id,
    async get() {
      return getSnapshot(this)
    },
  })
  const getSnapshot = (ref) => {
    const value = getCollection(ref.collectionName).get(ref.id)
    return {
      id: ref.id,
      ref,
      exists: value !== undefined,
      data: () => value && { ...value },
    }
  }

  const firestore = {
    collection(name) {
      return {
        doc(id) {
          return createRef(name, id || `generated-${++nextId}`)
        },
        where(field, operator, value) {
          return {
            limit(limitCount) {
              return {
                async get() {
                  assert.equal(operator, '==')
                  const docs = [...getCollection(name).entries()]
                    .filter(([, document]) => document[field] === value)
                    .slice(0, limitCount)
                    .map(([id, document]) => {
                      const ref = createRef(name, id)
                      return { id, ref, data: () => ({ ...document }) }
                    })
                  return { docs, empty: docs.length === 0 }
                },
              }
            },
          }
        },
      }
    },
    async runTransaction(work) {
      const previousTransaction = transactionTail
      let releaseTransaction
      transactionTail = new Promise((resolve) => {
        releaseTransaction = resolve
      })
      await previousTransaction

      try {
        const writes = []
        const transaction = {
          async get(ref) {
            return getSnapshot(ref)
          },
          update(ref, patch) {
            writes.push({ type: 'update', ref, value: { ...patch } })
          },
          set(ref, value) {
            writes.push({ type: 'set', ref, value: { ...value } })
          },
        }
        const result = await work(transaction)

        for (const write of writes) {
          const collection = getCollection(write.ref.collectionName)
          if (write.type === 'update') {
            const current = collection.get(write.ref.id)
            if (!current) throw new Error('Mock transaction cannot update a missing document.')
            collection.set(write.ref.id, { ...current, ...write.value })
          } else {
            collection.set(write.ref.id, write.value)
          }
        }
        return result
      } finally {
        releaseTransaction()
      }
    },
  }

  return {
    firestore,
    get(name, id) {
      const value = getCollection(name).get(id)
      return value && { ...value }
    },
    update(name, id, patch) {
      const current = getCollection(name).get(id)
      if (current) getCollection(name).set(id, { ...current, ...patch })
    },
    set(name, id, value) {
      getCollection(name).set(id, { ...value })
    },
    list(name) {
      return [...getCollection(name).values()].map((value) => ({ ...value }))
    },
    snapshot(name, id) {
      return getSnapshot(createRef(name, id))
    },
  }
}

function createFixture(totalStock = 10) {
  const mock = createMockFirestore({
    products: {
      'product-1': {
        name: 'Test saree',
        price: 2500,
        images: [],
        totalStock,
        reservedStock: 0,
        availableStock: totalStock,
        inStock: true,
        lowStockThreshold: 2,
      },
    },
  })

  return { mock, timestamp: mockTimestamp }
}

function captureFirestoreLogs(t) {
  const originalInfo = console.info
  const logs = []
  console.info = (message) => logs.push(String(message))
  t.after(() => {
    console.info = originalInfo
  })
  return logs
}

const reservationPayload = {
  productId: 'product-1',
  quantity: 2,
  customer: { name: 'Test Customer', phone: '9876543210', address: 'Test address' },
  selectedSize: '5.5 m',
  idempotencyKey: 'reservation-request-key-123456',
}
const testSecret = 'test-reservation-secret-value-long-enough'

async function createReservation(mock, timestamp, overrides = {}) {
  return createCheckoutReservation({ ...reservationPayload, ...overrides }, {
    firestore: mock.firestore,
    timestamp,
    cancellationSecret: testSecret,
  })
}

async function failReservationPayment(mock, timestamp, reservation) {
  const reservationRef = mock.firestore.collection('orders').doc(reservation.orderId)
  await mock.firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(reservationRef)
    const order = orderSnapshot.data()
    const release = await releaseReservationStockInTransaction(
      transaction,
      reservationRef,
      order,
      { firestore: mock.firestore, timestamp, reason: 'Test verified failure' },
    )
    transaction.update(reservationRef, {
      ...release.orderPatch,
      paymentMethod: 'razorpay',
      paymentStatus: 'failed',
      paymentAttempts: { 'failed-attempt': { status: 'failed' } },
    })
  })
}

async function confirmCreatedReservation(mock, timestamp) {
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
  })
  const confirmation = await confirmReservation(reservation.reservationId, 'admin-1', {
    firestore: mock.firestore,
    timestamp,
  })
  return { reservation, confirmation }
}

async function withMockReservationApi(mock, timestamp, callback, recordRequest = () => {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/reservations/create')
    const body = JSON.parse(options.body)
    recordRequest(body)
    const parsed = reservationSchema.safeParse(body)
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ message: 'Invalid reservation request.' }),
      }
    }

    try {
      const reservation = await createCheckoutReservation(parsed.data, {
        firestore: mock.firestore,
        timestamp,
        cancellationSecret: testSecret,
      })
      return { ok: true, status: 200, json: async () => ({ reservation }) }
    } catch (error) {
      return {
        ok: false,
        status: error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400,
        json: async () => ({ code: error.code, message: error.message }),
      }
    }
  }

  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function createClientReservationPayload(overrides = {}) {
  return {
    productId: 'product-1',
    quantity: 1,
    selectedSize: '5.5 m',
    idempotencyKey: 'cart-reservation-key-001',
    customer: {
      name: 'Test Customer',
      phone: '9876543210',
      doorNo: '12',
      streetName: 'Main Road',
      city: 'Chennai',
      pincode: '600001',
      state: 'Tamil Nadu',
    },
    ...overrides,
  }
}

test('reservation retry with the same idempotency key creates no duplicate order or reservation records', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  const second = await createReservation(mock, timestamp)
  const order = mock.get('orders', first.orderId)

  assert.equal(second.reservationId, first.reservationId)
  assert.equal(second.orderId, first.orderId)
  assert.equal(second.reservationStatus, 'active')
  assert.equal(order.orderType, 'online_order')
  assert.equal(order.paymentMethod, 'razorpay')
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.orderStatus, 'initiated')
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.list('reservationRequests').length, 1)
  assert.equal(mock.list('reservationTokens').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [10, 2, 8],
  )
})

test('identical request reuses an active reservation after a failed payment', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  await failReservationPayment(mock, timestamp, first)

  const retry = await createReservation(mock, timestamp)
  const originalOrder = mock.get('orders', first.orderId)

  assert.equal(retry.reservationId, first.reservationId)
  assert.equal(retry.orderId, first.orderId)
  assert.equal(originalOrder.reservationStatus, 'active')
  assert.equal(originalOrder.paymentStatus, 'failed')
  assert.equal(originalOrder.stockReserved, false)
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
})

test('identical request revalidates an expired reservation without creating another order', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  mock.update('orders', first.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
  })

  const retry = await createReservation(mock, timestamp)
  const renewedOrder = mock.get('orders', first.orderId)

  assert.equal(retry.reservationId, first.reservationId)
  assert.equal(retry.orderId, first.orderId)
  assert.equal(retry.reservationStatus, 'active')
  assert.equal(renewedOrder.reservationStatus, 'active')
  assert.equal(renewedOrder.stockReserved, true)
  assert.ok(renewedOrder.expiresAt.toMillis() > Date.now())
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.list('reservationRequests').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [2, 8],
  )
})

test('expired failed-payment retry revalidates stock and reuses the original order', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  await failReservationPayment(mock, timestamp, first)
  mock.update('orders', first.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
  })

  const retry = await createReservation(mock, timestamp)
  const renewedOrder = mock.get('orders', first.orderId)

  assert.equal(retry.orderId, first.orderId)
  assert.equal(retry.reservationId, first.reservationId)
  assert.equal(renewedOrder.paymentStatus, 'failed')
  assert.equal(renewedOrder.reservationStatus, 'active')
  assert.equal(renewedOrder.stockReserved, true)
  assert.equal(mock.list('orders').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [2, 8],
  )
})

test('released legacy checkout retries reuse the original order after stock is revalidated', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  mock.update('orders', first.orderId, {
    reservationStatus: 'released',
    stockReserved: false,
    checkoutAbandoned: true,
    paymentMethod: 'razorpay',
    paymentStatus: 'pending',
    paymentAttempts: {
      attempt: { status: 'pending', razorpayOrderId: 'order_previous1' },
    },
  })
  mock.update('products', 'product-1', { reservedStock: 0, availableStock: 10 })

  const retry = await createReservation(mock, timestamp)
  const renewedOrder = mock.get('orders', first.orderId)

  assert.equal(retry.orderId, first.orderId)
  assert.equal(retry.reservationId, first.reservationId)
  assert.equal(renewedOrder.reservationStatus, 'active')
  assert.equal(renewedOrder.checkoutAbandoned, false)
  assert.equal(renewedOrder.stockReserved, true)
  assert.equal(mock.list('orders').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [2, 8],
  )
})

test('expired payment retry cannot reacquire stock that is no longer available', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  await failReservationPayment(mock, timestamp, first)
  mock.update('orders', first.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
  })
  mock.update('products', 'product-1', {
    totalStock: 1,
    reservedStock: 0,
    availableStock: 1,
    inStock: true,
  })

  await assert.rejects(createReservation(mock, timestamp), { code: 'INSUFFICIENT_STOCK' })

  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.get('orders', first.orderId).stockReserved, false)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 1],
  )
})

test('identical request replaces a cancelled and restocked reservation', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  mock.update('orders', first.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
    refundStatus: 'processed',
  })
  await confirmReservation(first.reservationId, 'admin-1', {
    firestore: mock.firestore,
    timestamp,
  })
  await restockConvertedOrder(first.reservationId, 'admin-1', 'Test cancellation', {
    firestore: mock.firestore,
    timestamp,
  })

  const retry = await createReservation(mock, timestamp)

  assert.notEqual(retry.reservationId, first.reservationId)
  assert.equal(mock.get('orders', first.orderId).orderStatus, 'cancelled')
  assert.equal(mock.get('orders', first.orderId).stockRestored, true)
  assert.equal(mock.list('orders').length, 2)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [10, 2],
  )
})

test('identical request replaces a released reservation without changing its history', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  await failReservationPayment(mock, timestamp, first)
  await releaseReservation(first.reservationId, 'admin-1', 'Test release', {
    firestore: mock.firestore,
    timestamp,
  })

  const retry = await createReservation(mock, timestamp)

  assert.notEqual(retry.reservationId, first.reservationId)
  assert.equal(mock.get('orders', first.orderId).reservationStatus, 'released')
  assert.equal(mock.list('orders').length, 2)
  assert.equal(mock.list('reservationRequests').length, 2)
  assert.equal(mock.get('products', 'product-1').reservedStock, 2)
})

test('concurrent retries after expiration reuse one reservation and inventory hold', async () => {
  const { mock, timestamp } = createFixture()
  const first = await createReservation(mock, timestamp)
  mock.update('orders', first.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
  })

  const retries = await Promise.all(
    Array.from({ length: 8 }, () => createReservation(mock, timestamp)),
  )

  assert.equal(new Set(retries.map(({ reservationId }) => reservationId)).size, 1)
  assert.equal(retries[0].reservationId, first.reservationId)
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.list('reservationRequests').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [2, 8],
  )
})

test('quantity change after failed payment creates a reusable replacement reservation', async () => {
  const { mock, timestamp } = createFixture()
  const payload = createClientReservationPayload()

  await withMockReservationApi(mock, timestamp, async () => {
    const first = await createReservationRequest(payload)
    await failReservationPayment(mock, timestamp, first)

    const changed = await createReservationRequest({ ...payload, quantity: 2 })
    const retry = await createReservationRequest({ ...payload, quantity: 2 })

    assert.notEqual(changed.reservationId, first.reservationId)
    assert.equal(retry.reservationId, changed.reservationId)
    assert.equal(retry.reservedQuantity, 2)
    assert.equal(mock.get('orders', first.orderId).paymentStatus, 'failed')
    assert.equal(mock.get('orders', changed.orderId).reservationStatus, 'active')
    assert.equal(mock.get('products', 'product-1').reservedStock, 2)
    assert.equal(mock.list('orders').length, 2)
  })
})

test('identical client requests reuse one reservation key and concurrent submissions do not duplicate stock', async () => {
  const { mock, timestamp } = createFixture()
  const payload = createClientReservationPayload()
  const submittedKeys = []

  const { first, second, normalizedRetry } = await withMockReservationApi(mock, timestamp, async () => {
    const [firstResult, secondResult] = await Promise.all([
      createReservationRequest(payload),
      createReservationRequest(payload),
    ])
    const normalizedRetryResult = await createReservationRequest({
      ...payload,
      customer: {
        ...payload.customer,
        name: '  Test   Customer ',
        phone: '+91 98765 43210',
        streetName: ' Main   Road ',
      },
    })
    return {
      first: firstResult,
      second: secondResult,
      normalizedRetry: normalizedRetryResult,
    }
  }, (request) => submittedKeys.push(request.idempotencyKey))

  assert.equal(first.reservationId, second.reservationId)
  assert.equal(normalizedRetry.reservationId, first.reservationId)
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.list('reservationRequests').length, 1)
  assert.deepEqual(submittedKeys, [
    payload.idempotencyKey,
    payload.idempotencyKey,
    payload.idempotencyKey,
  ])
  assert.equal(mock.get('products', 'product-1').reservedStock, 1)
})

test('failed reservation retries unchanged but changed quantities get stable distinct keys', async () => {
  const { mock, timestamp } = createFixture()
  const payload = createClientReservationPayload()
  const submittedKeys = []

  await withMockReservationApi(mock, timestamp, async () => {
    const failedReservation = await createReservationRequest(payload)
    const failedOrderRef = mock.firestore.collection('orders').doc(failedReservation.orderId)
    await mock.firestore.runTransaction(async (transaction) => {
      const orderSnapshot = await transaction.get(failedOrderRef)
      const order = orderSnapshot.data()
      const release = await releaseReservationStockInTransaction(
        transaction,
        failedOrderRef,
        order,
        { firestore: mock.firestore, timestamp, reason: 'Test verified failure' },
      )
      transaction.update(failedOrderRef, {
        ...release.orderPatch,
        paymentMethod: 'razorpay',
        paymentStatus: 'failed',
      })
    })

    const unchangedRetry = await createReservationRequest(payload)
    assert.equal(unchangedRetry.reservationId, failedReservation.reservationId)

    const quantityTwo = await createReservationRequest({ ...payload, quantity: 2 })
    const quantityTwoRetry = await createReservationRequest({ ...payload, quantity: 2 })
    const quantityThree = await createReservationRequest({ ...payload, quantity: 3 })

    assert.equal(quantityTwoRetry.reservationId, quantityTwo.reservationId)
    assert.notEqual(quantityTwo.reservationId, failedReservation.reservationId)
    assert.notEqual(quantityThree.reservationId, quantityTwo.reservationId)
    assert.equal(mock.get('orders', failedReservation.orderId).paymentStatus, 'failed')
    assert.deepEqual(
      [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
      [5, 5],
    )
    assert.equal(mock.list('orders').length, 3)
  }, (request) => submittedKeys.push(request.idempotencyKey))

  const derivedQuantityTwoKeys = submittedKeys.filter((key) => key !== payload.idempotencyKey)
  assert.equal(derivedQuantityTwoKeys.length, 3)
  assert.equal(derivedQuantityTwoKeys[0], derivedQuantityTwoKeys[1])
  assert.notEqual(derivedQuantityTwoKeys[0], derivedQuantityTwoKeys[2])
})

test('changed quantity creates a separate reservation while the previous hold remains active', async () => {
  const { mock, timestamp } = createFixture(5)
  const payload = createClientReservationPayload()

  await withMockReservationApi(mock, timestamp, async () => {
    const first = await createReservationRequest(payload)
    const changed = await createReservationRequest({ ...payload, quantity: 2 })
    const changedRetry = await createReservationRequest({ ...payload, quantity: 2 })

    assert.notEqual(changed.reservationId, first.reservationId)
    assert.equal(changedRetry.reservationId, changed.reservationId)
    assert.equal(mock.get('orders', first.orderId).stockReserved, true)
    assert.deepEqual(
      [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
      [3, 2],
    )
    assert.equal(mock.list('orders').length, 2)
  })
})

test('product, size, and customer changes produce distinct reservation requests', async () => {
  const { mock, timestamp } = createFixture(10)
  await mock.firestore.runTransaction(async (transaction) => {
    transaction.set(mock.firestore.collection('products').doc('product-2'), {
      name: 'Second test saree',
      price: 2500,
      images: [],
      totalStock: 5,
      reservedStock: 0,
      availableStock: 5,
      inStock: true,
      lowStockThreshold: 2,
    })
  })
  const payload = createClientReservationPayload()

  await withMockReservationApi(mock, timestamp, async () => {
    const original = await createReservationRequest(payload)
    const changedSize = await createReservationRequest({ ...payload, selectedSize: '6 m' })
    const changedCustomer = await createReservationRequest({
      ...payload,
      customer: { ...payload.customer, phone: '9876543211' },
    })
    const changedProduct = await createReservationRequest({ ...payload, productId: 'product-2' })

    assert.equal(new Set([
      original.reservationId,
      changedSize.reservationId,
      changedCustomer.reservationId,
      changedProduct.reservationId,
    ]).size, 4)
    assert.deepEqual(
      [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-2').reservedStock],
      [3, 1],
    )
    assert.equal(mock.list('orders').length, 4)
  })
})

test('reservation create and status log fixed Firestore stages without request data', async (t) => {
  const logs = captureFirestoreLogs(t)
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)

  await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore },
  )

  const output = logs.join('\n')
  for (const stage of [
    'reservation_transaction',
    'reservation_idempotency_read',
    'reservation_product_read',
    'reservation_status_token_read',
    'reservation_status_orders_query',
  ]) {
    assert.match(output, new RegExp(`stage=${stage} outcome=success elapsed_ms=\\d+`))
  }
  assert.doesNotMatch(output, /Test Customer|Test address|reservation-request-key-123456|[a-f0-9]{64}/i)
})

test('failed Firestore operations log stage and elapsed time without error details', async (t) => {
  const logs = captureFirestoreLogs(t)
  const { mock, timestamp } = createFixture()
  mock.firestore.runTransaction = async () => {
    throw new Error('do-not-log-this-error-detail')
  }

  await assert.rejects(createReservation(mock, timestamp), /do-not-log-this-error-detail/)

  const output = logs.join('\n')
  assert.match(output, /stage=reservation_transaction outcome=failure elapsed_ms=\d+/)
  assert.doesNotMatch(output, /do-not-log-this-error-detail|reservation-request-key-123456|Test Customer/)
})

test('reservation creation preserves the exact requested quantity and rejects invalid or unavailable quantities', async () => {
  for (const quantity of [1, 3, 5]) {
    const { mock, timestamp } = createFixture(5)
    const reservation = await createReservation(mock, timestamp, {
      quantity,
      idempotencyKey: `quantity-request-${quantity}-key`,
    })
    const order = mock.get('orders', reservation.orderId)
    const product = mock.get('products', 'product-1')

    assert.equal(reservation.reservedQuantity, quantity)
    assert.equal(order.reservedQuantity, quantity)
    assert.equal(product.reservedStock, quantity)
    assert.equal(product.availableStock, 5 - quantity)
  }

  const { mock, timestamp } = createFixture(5)
  await assert.rejects(
    createReservation(mock, timestamp, { quantity: 6, idempotencyKey: 'quantity-request-too-many' }),
    { code: 'INSUFFICIENT_STOCK' },
  )
  for (const quantity of [0, -1, 1.5]) {
    await assert.rejects(
      createReservation(mock, timestamp, {
        quantity,
        idempotencyKey: `invalid-quantity-${String(quantity).replace('.', '-')}`,
      }),
      { code: 'INVALID_QUANTITY' },
    )
  }
  assert.equal(mock.list('orders').length, 0)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [5, 0, 5],
  )
})

test('concurrent reservations cannot oversell the available stock', async () => {
  const { mock, timestamp } = createFixture(5)
  const results = await Promise.allSettled([
    createReservation(mock, timestamp, { quantity: 3, idempotencyKey: 'concurrent-reservation-key-1' }),
    createReservation(mock, timestamp, { quantity: 3, idempotencyKey: 'concurrent-reservation-key-2' }),
  ])
  const successful = results.filter((result) => result.status === 'fulfilled')
  const failed = results.filter((result) => result.status === 'rejected')

  assert.equal(successful.length, 1)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].reason.code, 'INSUFFICIENT_STOCK')
  assert.equal(mock.list('orders').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [5, 3, 2],
  )
})

test('two customers competing for the last unit cannot both reserve it', async () => {
  const { mock, timestamp } = createFixture(1)
  const results = await Promise.allSettled([
    createReservation(mock, timestamp, {
      quantity: 1,
      idempotencyKey: 'last-unit-customer-one',
    }),
    createReservation(mock, timestamp, {
      quantity: 1,
      idempotencyKey: 'last-unit-customer-two',
      customer: { name: 'Another Customer', phone: '9876543211', address: 'Another address' },
    }),
  ])
  const successful = results.filter((result) => result.status === 'fulfilled')
  const failed = results.filter((result) => result.status === 'rejected')

  assert.equal(successful.length, 1)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].reason.code, 'INSUFFICIENT_STOCK')
  assert.equal(mock.list('orders').length, 1)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [1, 0],
  )
})

test('expired reservations release their stock exactly once', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
  })

  assert.equal(await expireReservation(mock.snapshot('orders', reservation.orderId), {
    firestore: mock.firestore,
    timestamp,
  }), true)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 10],
  )
  assert.equal(mock.get('orders', reservation.orderId).stockReserved, false)
  const historyCount = mock.list('inventoryHistory').length
  assert.equal(await expireReservation(mock.snapshot('orders', reservation.orderId), {
    firestore: mock.firestore,
    timestamp,
  }), false)
  assert.equal(mock.list('inventoryHistory').length, historyCount)
  assert.equal(historyCount, 2)
})

test('fresh confirmation persists both canonical statuses and a retry does not deduct stock again', async () => {
  const { mock, timestamp } = createFixture()
  const { reservation, confirmation } = await confirmCreatedReservation(mock, timestamp)
  const confirmedOrder = mock.get('orders', reservation.orderId)
  const confirmedProduct = mock.get('products', 'product-1')

  assert.equal(confirmation.orderStatus, 'confirmed')
  assert.equal(confirmation.reservationStatus, 'converted')
  assert.equal(confirmedOrder.orderStatus, 'confirmed')
  assert.equal(confirmedOrder.reservationStatus, 'converted')
  assert.equal(confirmedOrder.stockDeducted, true)
  assert.deepEqual([confirmedProduct.totalStock, confirmedProduct.reservedStock, confirmedProduct.availableStock], [8, 0, 8])

  const historyCount = mock.list('inventoryHistory').length
  const retry = await confirmReservation(reservation.reservationId, 'admin-1', {
    firestore: mock.firestore,
    timestamp,
  })

  assert.equal(retry.orderStatus, 'confirmed')
  assert.equal(mock.get('products', 'product-1').totalStock, 8)
  assert.equal(mock.list('inventoryHistory').length, historyCount)
})

test('customer status lookup returns only the latest non-private reservation state', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)

  const pending = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore, now: () => Date.now() },
  )
  assert.equal(pending.status, 'pending')
  assert.equal(pending.productName, 'Test saree')
  assert.equal(pending.paymentStatus, 'pending')
  assert.equal(pending.paymentMethod, 'razorpay')
  assert.ok(Number.isFinite(Date.parse(pending.createdAt)))
  assert.equal('customer' in pending, false)
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'authorized',
  })
  const paymentPendingCapture = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore },
  )
  assert.equal(paymentPendingCapture.paymentMethod, 'razorpay')
  assert.equal(paymentPendingCapture.paymentStatus, 'authorized')
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'whatsapp',
    paymentStatus: 'pending',
  })

  const expired = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore, now: () => Date.now() + 31 * 60 * 1000 },
  )
  assert.equal(expired.status, 'expired')

  await assert.rejects(
    confirmReservation(reservation.reservationId, 'admin-1', {
      firestore: mock.firestore,
      timestamp,
    }),
    { code: 'AUTOMATIC_CONFIRMATION_REQUIRED' },
  )

  mock.update('orders', reservation.orderId, { orderStatus: 'delivered' })
  const completed = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore },
  )
  assert.equal(completed.status, 'delivered')

  await assert.rejects(
    getCustomerReservationStatus(reservation.reservationId, 'f'.repeat(64), { firestore: mock.firestore }),
    { code: 'INVALID_CANCELLATION_TOKEN' },
  )
})

test('first restock returns stock once and repeated restock preserves the cancelled status', async () => {
  const { mock, timestamp } = createFixture()
  const { reservation } = await confirmCreatedReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, { refundStatus: 'processed' })

  const first = await restockConvertedOrder(reservation.reservationId, 'admin-1', 'Test restock', {
    firestore: mock.firestore,
    timestamp,
  })
  const historyCount = mock.list('inventoryHistory').length
  const firstProduct = mock.get('products', 'product-1')
  const firstOrder = mock.get('orders', reservation.orderId)

  assert.equal(first.status, 'restocked')
  assert.equal(first.orderStatus, 'cancelled')
  assert.equal(first.stockRestored, true)
  const customerStatus = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore },
  )
  assert.equal(customerStatus.status, 'cancelled')
  assert.equal(firstOrder.orderStatus, 'cancelled')
  assert.equal(firstOrder.stockRestored, true)
  assert.deepEqual([firstProduct.totalStock, firstProduct.reservedStock, firstProduct.availableStock], [10, 0, 10])

  const retry = await restockConvertedOrder(reservation.reservationId, 'admin-1', 'Test retry', {
    firestore: mock.firestore,
    timestamp,
  })

  assert.equal(retry.orderStatus, 'cancelled')
  assert.equal(mock.get('orders', reservation.orderId).orderStatus, 'cancelled')
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [10, 0, 10],
  )
  assert.equal(mock.list('inventoryHistory').length, historyCount)
})

test('confirmation after restock conflicts without changing stock or persisted status', async () => {
  const { mock, timestamp } = createFixture()
  const { reservation } = await confirmCreatedReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, { refundStatus: 'processed' })
  await restockConvertedOrder(reservation.reservationId, 'admin-1', 'Test restock', {
    firestore: mock.firestore,
    timestamp,
  })

  await assert.rejects(
    confirmReservation(reservation.reservationId, 'admin-1', { firestore: mock.firestore, timestamp }),
    { code: 'RESERVATION_CONVERTED' },
  )
  assert.equal(mock.get('orders', reservation.orderId).orderStatus, 'cancelled')
  assert.equal(mock.get('products', 'product-1').totalStock, 10)
})

test('cancellation, admin release, and expiry cannot release converted stock', async () => {
  const { mock, timestamp } = createFixture()
  const { reservation } = await confirmCreatedReservation(mock, timestamp)

  await assert.rejects(
    cancelReservation(reservation.reservationId, reservation.cancellationToken, {
      firestore: mock.firestore,
      timestamp,
    }),
    { code: 'PAYMENT_CAPTURED' },
  )
  await assert.rejects(
    releaseReservation(reservation.reservationId, 'admin-1', 'Test release', {
      firestore: mock.firestore,
      timestamp,
    }),
    { code: 'PAYMENT_CAPTURED' },
  )
  assert.equal(await expireReservation(mock.snapshot('orders', reservation.orderId), {
    firestore: mock.firestore,
    timestamp,
  }), false)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [8, 0, 8],
  )
})

test('active Razorpay payment attempts cannot be cancelled or released before resolution', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'pending',
    paymentAttempts: { attempt: { status: 'pending' } },
  })

  await assert.rejects(
    cancelReservation(reservation.reservationId, reservation.cancellationToken, {
      firestore: mock.firestore,
      timestamp,
    }),
    { code: 'PAYMENT_IN_PROGRESS' },
  )
  await assert.rejects(
    releaseReservation(reservation.reservationId, 'admin-1', 'Test release', {
      firestore: mock.firestore,
      timestamp,
    }),
    { code: 'PAYMENT_IN_PROGRESS' },
  )
  assert.equal(mock.get('products', 'product-1').reservedStock, 2)
})

test('admin release reconciles a verified failed payment and restores inventory once', async () => {
  const { mock, timestamp } = createFixture(4)
  const reservation = await createReservation(mock, timestamp, { quantity: 3 })
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'failed',
    paymentAttempts: { attempt: { status: 'failed' } },
  })

  const result = await releaseReservation(reservation.reservationId, 'admin-1', 'Test release', {
    firestore: mock.firestore,
    timestamp,
  })
  const repeated = await releaseReservation(reservation.reservationId, 'admin-1', 'Retry release', {
    firestore: mock.firestore,
    timestamp,
  })

  assert.equal(result.status, 'released')
  assert.equal(repeated.status, 'released')
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [4, 0, 4],
  )
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('customer cancellation reconciles a verified failed payment', async () => {
  const { mock, timestamp } = createFixture(4)
  const reservation = await createReservation(mock, timestamp, { quantity: 3 })
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'failed',
    paymentAttempts: { attempt: { status: 'failed' } },
  })

  const result = await cancelReservation(reservation.reservationId, reservation.cancellationToken, {
    firestore: mock.firestore,
    timestamp,
  })
  const repeated = await cancelReservation(reservation.reservationId, reservation.cancellationToken, {
    firestore: mock.firestore,
    timestamp,
  })

  assert.equal(result.status, 'released')
  assert.equal(repeated.status, 'released')
  assert.equal(mock.get('orders', reservation.orderId).reservationStatus, 'released')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 4],
  )
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('customer cancellation recovers after payment reconciliation fails', async () => {
  const { mock, timestamp } = createFixture(4)
  const reservation = await createReservation(mock, timestamp, { quantity: 3 })
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'failed',
    paymentAttempts: { attempt: { status: 'failed' } },
  })

  await assert.rejects(
    cancelReservation(reservation.reservationId, reservation.cancellationToken, {
      firestore: mock.firestore,
      timestamp,
      reconcilePayment: async () => {
        throw Object.assign(new Error('Payment status temporarily unavailable.'), {
          code: 'PAYMENT_STATUS_UNAVAILABLE',
        })
      },
    }),
    { code: 'PAYMENT_STATUS_UNAVAILABLE' },
  )
  assert.equal(mock.get('orders', reservation.orderId).reservationStatus, 'active')
  assert.equal(mock.get('orders', reservation.orderId).paymentStatus, 'failed')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [3, 1],
  )

  const result = await cancelReservation(reservation.reservationId, reservation.cancellationToken, {
    firestore: mock.firestore,
    timestamp,
    reconcilePayment: async () => ({ status: 'failed' }),
  })
  const repeated = await cancelReservation(reservation.reservationId, reservation.cancellationToken, {
    firestore: mock.firestore,
    timestamp,
    reconcilePayment: async () => ({ status: 'failed' }),
  })

  assert.equal(result.status, 'released')
  assert.equal(repeated.status, 'released')
  assert.equal(mock.get('orders', reservation.orderId).reservationStatus, 'released')
  assert.equal(mock.get('orders', reservation.orderId).paymentStatus, 'failed')
  assert.equal(mock.get('orders', reservation.orderId).orderStatus, 'initiated')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 4],
  )
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('verified failure releases stock for a full-quantity checkout retry', async () => {
  const { mock, timestamp } = createFixture(4)
  const reservation = await createReservation(mock, timestamp, { quantity: 3 })
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'failed',
    paymentAttempts: { attempt: { status: 'failed' } },
  })

  await releaseReservation(reservation.reservationId, 'admin-1', 'Verified failure', {
    firestore: mock.firestore,
    timestamp,
  })
  const retry = await createReservation(mock, timestamp, {
    quantity: 4,
    idempotencyKey: 'reserve-all-available-after-payment-failure',
  })

  assert.equal(retry.reservedQuantity, 4)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [4, 4, 0],
  )
})

test('pending and captured payments cannot be force-released or cancelled', async () => {
  for (const paymentStatus of ['pending', 'captured']) {
    const { mock, timestamp } = createFixture()
    const reservation = await createReservation(mock, timestamp)
    mock.update('orders', reservation.orderId, {
      paymentMethod: 'razorpay',
      paymentStatus,
      paymentAttempts: { attempt: { status: paymentStatus } },
    })

    await assert.rejects(
      releaseReservation(reservation.reservationId, 'admin-1', 'Test release', {
        firestore: mock.firestore,
        timestamp,
      }),
      { code: paymentStatus === 'captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_IN_PROGRESS' },
    )
    await assert.rejects(
      cancelReservation(reservation.reservationId, reservation.cancellationToken, {
        firestore: mock.firestore,
        timestamp,
      }),
      { code: paymentStatus === 'captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_IN_PROGRESS' },
    )
    assert.equal(
      mock.get('products', 'product-1').reservedStock,
      paymentStatus === 'captured' ? 0 : 2,
    )
  }
})

test('expired reservation with unresolved Razorpay payment releases stock without marking it failed', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
    paymentMethod: 'razorpay',
    paymentStatus: 'pending',
    paymentAttempts: { attempt: { status: 'pending' } },
  })

  const expired = await expireReservation(mock.snapshot('orders', reservation.orderId), {
      firestore: mock.firestore,
      timestamp,
    })
  const order = mock.get('orders', reservation.orderId)
  assert.equal(expired, true)
  assert.equal(order.reservationStatus, 'expired')
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentReconciliationStatus, 'pending')
  assert.equal(order.inventoryOwnershipStatus, 'released_pending_verification')
  assert.equal(order.checkoutAbandoned, true)
  assert.equal(order.stockReserved, false)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 10],
  )
  const customerStatus = await getCustomerReservationStatus(
    reservation.reservationId,
    reservation.cancellationToken,
    { firestore: mock.firestore },
  )
  assert.equal(customerStatus.paymentStatus, 'pending')
  assert.equal(customerStatus.inventoryStatus, 'released')
})

test('expired reservation releases its hold if immediate Razorpay reconciliation is unavailable', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    expiresAt: createTimestamp(Date.now() - 1),
    paymentMethod: 'razorpay',
    paymentStatus: 'pending',
    paymentAttempts: {
      attempt: { status: 'pending', razorpayOrderId: 'order_unavailable1' },
    },
  })

  const result = await expireReservation(mock.snapshot('orders', reservation.orderId), {
    firestore: mock.firestore,
    timestamp,
    reconcilePayment: async () => {
      throw Object.assign(new Error('Provider unavailable'), { code: 'PAYMENT_STATUS_UNAVAILABLE' })
    },
  })
  const order = mock.get('orders', reservation.orderId)

  assert.equal(result, true)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentReconciliationStatus, 'pending')
  assert.equal(order.stockReserved, false)
  assert.equal(mock.get('products', 'product-1').availableStock, 10)
})

test('concurrent admin release and customer cancellation release failed-payment stock once', async () => {
  const { mock, timestamp } = createFixture()
  const reservation = await createReservation(mock, timestamp)
  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'failed',
    paymentAttempts: { attempt: { status: 'failed' } },
  })

  const results = await Promise.all([
    releaseReservation(reservation.reservationId, 'admin-1', 'Concurrent release', {
      firestore: mock.firestore,
      timestamp,
    }),
    cancelReservation(reservation.reservationId, reservation.cancellationToken, {
      firestore: mock.firestore,
      timestamp,
    }),
  ])

  assert.equal(results.length, 2)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
  assert.equal(mock.get('products', 'product-1').availableStock, 10)
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('multi-item reservation prices and holds every product in one order, then fulfills all items together', async () => {
  const { mock, timestamp } = createFixture(1)
  mock.set('products', 'product-1', {
    name: 'Floral Dola Silk Fancy Saree',
    price: 2499,
    images: ['floral.jpg'],
    totalStock: 1,
    reservedStock: 0,
    availableStock: 1,
    inStock: true,
  })
  mock.set('products', 'product-2', {
    name: 'Mangalagiri Handloom Cotton Saree',
    price: 2899,
    images: [{ url: 'mangalagiri.jpg' }],
    totalStock: 1,
    reservedStock: 0,
    availableStock: 1,
    inStock: true,
  })
  const request = {
    items: [
      { productId: 'product-1', quantity: 1, selectedSize: '5.5 m' },
      { productId: 'product-2', quantity: 1, selectedSize: '6.3 m' },
    ],
    customer: createClientReservationPayload().customer,
    idempotencyKey: reservationPayload.idempotencyKey,
  }
  const parsed = reservationSchema.safeParse(request)
  assert.equal(parsed.success, true)

  const reservation = await createCheckoutReservation(parsed.data, {
    firestore: mock.firestore,
    timestamp,
    cancellationSecret: testSecret,
  })
  const order = mock.get('orders', reservation.orderId)
  assert.equal(order.totalAmount, 5398)
  assert.equal(order.items.length, 2)
  assert.deepEqual(order.items.map(({ productId, price, quantity }) => ({ productId, price, quantity })), [
    { productId: 'product-1', price: 2499, quantity: 1 },
    { productId: 'product-2', price: 2899, quantity: 1 },
  ])
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.get('products', 'product-1').reservedStock, 1)
  assert.equal(mock.get('products', 'product-2').reservedStock, 1)
  assert.equal(reservation.totalAmount, 5398)

  const retry = await createCheckoutReservation(parsed.data, {
    firestore: mock.firestore,
    timestamp,
    cancellationSecret: testSecret,
  })
  assert.equal(retry.reservationId, reservation.reservationId)
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.get('products', 'product-1').reservedStock, 1)
  assert.equal(mock.get('products', 'product-2').reservedStock, 1)

  mock.update('orders', reservation.orderId, {
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
  })
  const confirmation = await confirmReservation(reservation.reservationId, 'admin-1', {
    firestore: mock.firestore,
    timestamp,
  })
  assert.equal(confirmation.orderStatus, 'confirmed')
  assert.equal(mock.get('products', 'product-1').totalStock, 0)
  assert.equal(mock.get('products', 'product-2').totalStock, 0)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
  assert.equal(mock.get('products', 'product-2').reservedStock, 0)
})

test('one unavailable multi-item product aborts the complete reservation without partial inventory holds', async () => {
  const { mock, timestamp } = createFixture(1)
  mock.set('products', 'product-2', {
    name: 'Unavailable saree',
    price: 2899,
    images: [],
    totalStock: 0,
    reservedStock: 0,
    availableStock: 0,
    inStock: false,
  })

  await assert.rejects(createCheckoutReservation({
    items: [
      { productId: 'product-1', quantity: 1 },
      { productId: 'product-2', quantity: 1 },
    ],
    customer: reservationPayload.customer,
    idempotencyKey: reservationPayload.idempotencyKey,
  }, {
    firestore: mock.firestore,
    timestamp,
    cancellationSecret: testSecret,
  }), { code: 'INSUFFICIENT_STOCK' })

  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
  assert.equal(mock.get('products', 'product-1').availableStock, 1)
  assert.equal(mock.get('products', 'product-2').reservedStock, 0)
  assert.equal(mock.list('orders').length, 0)
})
