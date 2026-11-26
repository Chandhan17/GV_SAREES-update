import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import createOrderHandler from '../api/razorpay/create-order.js'
import verifyHandler from '../api/razorpay/verify.js'
import {
  calculateRazorpayAmountPaise,
  abandonRazorpayCheckout,
  createRazorpayPaymentOrder,
  recordRazorpayPaymentFailure,
  reconcileRazorpayReservationPayment,
  verifyRazorpayPayment,
} from '../server/razorpayPaymentService.js'
import { hashCancellationToken } from '../server/reservationSecurity.js'
import { confirmReservation } from '../server/reservationService.js'

const reservationId = 'cc970f63-fbe7-46b3-bd65-bd623f25c039'
const cancellationToken = 'a'.repeat(64)
const keyId = 'rzp_test_example'
const keySecret = 'test-secret-not-a-real-credential'
const paymentConfiguration = {
  keyId,
  publicKeyId: keyId,
  keySecret,
}

function createMockFirestore({
  totalStock = 5,
  reservedStock = 2,
  reservedQuantity = 2,
} = {}) {
  const collections = new Map([
    ['reservationTokens', new Map([
      [reservationId, { tokenHash: hashCancellationToken(cancellationToken) }],
    ])],
    ['orders', new Map([
      ['application-order-1', {
        reservationId,
        productId: 'product-1',
        reservationStatus: 'active',
        reservedQuantity,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        paymentMethod: 'whatsapp',
        paymentStatus: 'pending',
        orderStatus: 'initiated',
        stockDeducted: false,
        stockRestored: false,
      }],
    ])],
    ['products', new Map([
      ['product-1', {
        name: 'Test saree',
        price: 25.75,
        totalStock,
        reservedStock,
        availableStock: totalStock - reservedStock,
      }],
    ])],
  ])
  let transactionTail = Promise.resolve()
  let updateCount = 0
  let generatedDocumentId = 0

  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const makeRef = (name, id) => ({
    collectionName: name,
    id,
    async get() {
      return makeSnapshot(this)
    },
  })
  const makeSnapshot = (ref) => {
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
          return makeRef(name, id || `generated-${++generatedDocumentId}`)
        },
        where(field, operator, value) {
          return {
            limit(limitCount) {
              return {
                async get() {
                  const docs = [...getCollection(name).entries()]
                    .filter(([, document]) => operator === 'array-contains'
                      ? document[field]?.includes(value)
                      : document[field] === value)
                    .slice(0, limitCount)
                    .map(([id]) => {
                      const ref = makeRef(name, id)
                      return { id, ref, data: () => makeSnapshot(ref).data() }
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
      const previous = transactionTail
      let release
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
      try {
        const writes = []
        const transaction = {
          async get(ref) {
            return makeSnapshot(ref)
          },
          update(ref, patch) {
            writes.push({ ref, patch, type: 'update' })
          },
          set(ref, value) {
            writes.push({ ref, patch: value, type: 'set' })
          },
        }
        const result = await work(transaction)
        for (const { ref, patch, type } of writes) {
          const documents = getCollection(ref.collectionName)
          const current = documents.get(ref.id)
          if (type === 'set') {
            documents.set(ref.id, patch)
          } else {
            assert.ok(current, `Missing ${ref.collectionName}/${ref.id}`)
            documents.set(ref.id, { ...current, ...patch })
          }
          updateCount += 1
        }
        return result
      } finally {
        release()
      }
    },
  }

  return {
    firestore,
    get(name, id) {
      const value = getCollection(name).get(id)
      return value && { ...value }
    },
    list(name) {
      return [...getCollection(name).values()]
    },
    set(name, id, value) {
      getCollection(name).set(id, value)
    },
    get updateCount() {
      return updateCount
    },
  }
}

function createGateway() {
  let orderNumber = 0
  const payments = new Map()
  const createdOrders = []
  return {
    gateway: {
      orders: {
        async create(payload) {
          createdOrders.push(payload)
          orderNumber += 1
          return { id: `order_mock${orderNumber}`, amount: payload.amount, currency: payload.currency }
        },
      },
      payments: {
        async fetch(paymentId) {
          const payment = payments.get(paymentId)
          if (!payment) throw new Error('Unknown payment')
          return payment
        },
      },
    },
    payments,
    createdOrders,
  }
}

function createReconciliationGateway(status, amount = 5_150) {
  let createdOrder
  const paymentStatus = status === 'captured' ? 'captured' : status
  return {
    gateway: {
      orders: {
        async create(payload) {
          createdOrder = { id: 'order_reconcile1', amount: payload.amount, currency: payload.currency }
          return createdOrder
        },
        async fetch(orderId) {
          return {
            id: orderId,
            amount,
            amount_paid: paymentStatus === 'captured' ? amount : 0,
            currency: 'INR',
            status: paymentStatus === 'captured' ? 'paid' : 'attempted',
            attempts: 1,
          }
        },
        async fetchPayments(orderId) {
          return {
            count: 1,
            items: [{
              id: 'pay_reconcile1',
              order_id: orderId,
              amount,
              currency: 'INR',
              status: paymentStatus,
            }],
          }
        },
      },
    },
    get createdOrder() {
      return createdOrder
    },
  }
}

function signPayment(orderId, paymentId) {
  return createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')
}

function createApiResponse() {
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

function createOrderInput(overrides = {}) {
  return {
    reservationId,
    cancellationToken,
    idempotencyKey: 'checkout-attempt-key-001',
    ...overrides,
  }
}

test('Razorpay amount uses the authoritative product price and reserved quantity in paise', async () => {
  assert.equal(calculateRazorpayAmountPaise(19.99, 2), 3998)
  const mock = createMockFirestore()
  const { gateway, createdOrders } = createGateway()

  const result = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.amount, 5150)
  assert.equal(result.currency, 'INR')
  assert.equal(result.keyId, keyId)
  assert.deepEqual(createdOrders, [{
    amount: 5150,
    currency: 'INR',
    receipt: `payment-${createHashForTest('checkout-attempt-key-001').slice(0, 32)}`,
  }])
})

test('one multi-item reservation creates one Razorpay order for authoritative combined prices and verifies that full amount', async () => {
  const mock = createMockFirestore({ totalStock: 1, reservedStock: 1, reservedQuantity: 2 })
  mock.set('products', 'product-1', {
    name: 'Floral Dola Silk Fancy Saree',
    price: 2499,
    totalStock: 1,
    reservedStock: 1,
    availableStock: 0,
  })
  mock.set('products', 'product-2', {
    name: 'Mangalagiri Handloom Cotton Saree',
    price: 2899,
    totalStock: 1,
    reservedStock: 1,
    availableStock: 0,
  })
  mock.set('orders', 'application-order-1', {
    ...mock.get('orders', 'application-order-1'),
    productName: 'Floral Dola Silk Fancy Saree',
    productId: 'product-1',
    items: [
      { productId: 'product-1', productName: 'Floral Dola Silk Fancy Saree', quantity: 1, price: 1 },
      { productId: 'product-2', productName: 'Mangalagiri Handloom Cotton Saree', quantity: 1, price: 1 },
    ],
    stockReserved: true,
  })
  const { gateway, createdOrders, payments } = createGateway()
  const paymentOrder = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(paymentOrder.amount, 539800)
  assert.equal(paymentOrder.currency, 'INR')
  assert.equal(createdOrders.length, 1)
  assert.equal(createdOrders[0].amount, 539800)
  const savedOrder = mock.get('orders', 'application-order-1')
  assert.equal(savedOrder.totalAmount, 5398)
  assert.deepEqual(savedOrder.items.map(({ productId, price, lineSubtotal }) => ({ productId, price, lineSubtotal })), [
    { productId: 'product-1', price: 2499, lineSubtotal: 2499 },
    { productId: 'product-2', price: 2899, lineSubtotal: 2899 },
  ])

  const paymentId = 'pay_multi123'
  payments.set(paymentId, {
    id: paymentId,
    order_id: paymentOrder.razorpayOrderId,
    amount: 539799,
    currency: 'INR',
    status: 'captured',
  })
  await assert.rejects(verifyRazorpayPayment({
    razorpay_order_id: paymentOrder.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(paymentOrder.razorpayOrderId, paymentId),
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  }), { code: 'PAYMENT_DETAILS_MISMATCH' })
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')

  payments.set(paymentId, {
    id: paymentId,
    order_id: paymentOrder.razorpayOrderId,
    amount: 539800,
    currency: 'INR',
    status: 'captured',
  })
  const verification = await verifyRazorpayPayment({
    razorpay_order_id: paymentOrder.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(paymentOrder.razorpayOrderId, paymentId),
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.deepEqual(verification, { status: 'captured', duplicate: false })
  assert.equal(mock.get('orders', 'application-order-1').orderStatus, 'confirmed')
  assert.equal(mock.get('products', 'product-1').totalStock, 0)
  assert.equal(mock.get('products', 'product-2').totalStock, 0)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
  assert.equal(mock.get('products', 'product-2').reservedStock, 0)
})

test('repeating the same payment-order request returns the existing Razorpay order', async () => {
  const mock = createMockFirestore()
  const { gateway, createdOrders } = createGateway()
  const input = createOrderInput()

  const first = await createRazorpayPaymentOrder(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const retry = await createRazorpayPaymentOrder(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(retry.razorpayOrderId, first.razorpayOrderId)
  assert.equal(createdOrders.length, 1)
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
})

test('concurrent retries for the same payment attempt cannot create two Razorpay orders', async () => {
  const mock = createMockFirestore()
  const { gateway, createdOrders } = createGateway()
  const results = await Promise.allSettled([
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(createdOrders.length, 1)
})

test('frontend amount and currency fields are rejected instead of trusted', async () => {
  let called = false
  const request = {
    method: 'POST',
    body: { ...createOrderInput(), amount: 1, currency: 'USD' },
  }
  const response = createApiResponse()
  await createOrderHandler(request, response, {
    createPaymentOrder: async () => {
      called = true
    },
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 400)
  assert.equal(called, false)
})

test('verification API returns only the server-verified payment state', async () => {
  const response = createApiResponse()
  await verifyHandler({
    method: 'POST',
    body: {
      razorpay_order_id: 'order_mock1',
      razorpay_payment_id: 'pay_mock1',
      razorpay_signature: 'a'.repeat(64),
    },
  }, response, {
    verifyPayment: async () => ({ status: 'authorized', duplicate: false }),
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { status: 'authorized' })
  assert.equal(response.headers['Cache-Control'], 'no-store')
})

test('verification API accepts a failure callback without a payment ID for reconciliation', async () => {
  const response = createApiResponse()
  let received
  await verifyHandler({
    method: 'POST',
    body: {
      reservationId,
      cancellationToken,
      razorpay_order_id: 'order_mock1',
    },
  }, response, {
    recordFailure: async (input) => {
      received = input
      return { status: 'pending' }
    },
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { status: 'pending' })
  assert.deepEqual(received, {
    reservationId,
    cancellationToken,
    razorpay_order_id: 'order_mock1',
  })
})

test('verification API accepts a scoped checkout dismissal request', async () => {
  const response = createApiResponse()
  let received
  await verifyHandler({
    method: 'POST',
    body: {
      action: 'checkout-dismissed',
      reservationId,
      cancellationToken,
      razorpay_order_id: 'order_mock1',
    },
  }, response, {
    abandonCheckout: async (input) => {
      received = input
      return {
        status: 'pending',
        inventoryStatus: 'released',
        paymentOutcome: 'pending',
        releaseOperationResult: 'released',
      }
    },
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(received, {
    action: 'checkout-dismissed',
    reservationId,
    cancellationToken,
    razorpay_order_id: 'order_mock1',
  })
  assert.deepEqual(response.body, {
    status: 'pending',
    inventoryStatus: 'released',
    paymentOutcome: 'pending',
    releaseOperationResult: 'released',
  })
})

test('invalid reservation token and unsupported product currency are rejected', async () => {
  const invalidTokenMock = createMockFirestore()
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput({ cancellationToken: 'f'.repeat(64) }), {
      ...paymentConfiguration,
      firestore: invalidTokenMock.firestore,
      razorpay: createGateway().gateway,
    }),
    { code: 'INVALID_RESERVATION_TOKEN' },
  )

  const invalidCurrencyMock = createMockFirestore()
  invalidCurrencyMock.set('products', 'product-1', {
    ...invalidCurrencyMock.get('products', 'product-1'),
    currency: 'USD',
  })
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      firestore: invalidCurrencyMock.firestore,
      razorpay: createGateway().gateway,
    }),
    { code: 'INVALID_CURRENCY' },
  )
})

test('live-mode or mismatched public/server key IDs are rejected', async () => {
  const mock = createMockFirestore()
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      keyId: 'rzp_live_example',
      publicKeyId: 'rzp_live_example',
      firestore: mock.firestore,
      razorpay: createGateway().gateway,
    }),
    { code: 'TEST_MODE_REQUIRED' },
  )
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      publicKeyId: 'rzp_test_other',
      firestore: mock.firestore,
      razorpay: createGateway().gateway,
    }),
    { code: 'TEST_MODE_REQUIRED' },
  )
})

test('mismatched Razorpay order IDs and invalid signatures cannot update payment status', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_mock1'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'captured',
  })

  await assert.rejects(
    verifyRazorpayPayment({
      razorpay_order_id: 'order_notassociated',
      razorpay_payment_id: paymentId,
      razorpay_signature: signPayment('order_notassociated', paymentId),
    }, {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'PAYMENT_ORDER_NOT_FOUND' },
  )
  await assert.rejects(
    verifyRazorpayPayment({
      razorpay_order_id: order.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: '0'.repeat(64),
    }, {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'INVALID_PAYMENT_SIGNATURE' },
  )
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
})

test('verified payment amount and currency must match the stored expected values', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_mock2'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount - 1,
    currency: 'USD',
    status: 'captured',
  })

  await assert.rejects(
    verifyRazorpayPayment({
      razorpay_order_id: order.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signPayment(order.razorpayOrderId, paymentId),
    }, {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'PAYMENT_DETAILS_MISMATCH' },
  )
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
})

test('captured verification is idempotent and authorized is not treated as captured', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_mock3'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'authorized',
  })
  const input = {
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(order.razorpayOrderId, paymentId),
  }

  const authorized = await verifyRazorpayPayment(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(authorized.status, 'authorized')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'authorized')

  payments.set(paymentId, { ...payments.get(paymentId), status: 'captured' })
  const updatesBeforeCapture = mock.updateCount
  const captured = await verifyRazorpayPayment(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(captured.status, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'captured')

  const updatesAfterCapture = mock.updateCount
  const duplicate = await verifyRazorpayPayment(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.deepEqual(duplicate, { status: 'captured', duplicate: true })
  assert.equal(mock.updateCount, updatesAfterCapture)
  assert.ok(updatesAfterCapture > updatesBeforeCapture)
})

test('failed payments are recorded as failed and captured reservations reject new attempts', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_mock4'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'failed',
  })
  const failed = await verifyRazorpayPayment({
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(order.razorpayOrderId, paymentId),
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(failed.status, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'failed')

  mock.set('orders', 'application-order-1', {
    ...mock.get('orders', 'application-order-1'),
    paymentStatus: 'captured',
  })
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput({ idempotencyKey: 'checkout-attempt-key-002' }), {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'RESERVATION_ALREADY_PAID' },
  )
  await assert.rejects(
    createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'RESERVATION_ALREADY_PAID' },
  )
})

test('payment creation continues to reject terminal and expired reservations', async () => {
  const terminalStates = [
    { reservationStatus: 'expired' },
    { reservationStatus: 'released' },
    { orderStatus: 'cancelled' },
    { orderStatus: 'completed' },
    { stockRestored: true },
    { reservationStatus: 'active', expiresAt: new Date(Date.now() - 1) },
  ]

  for (const terminalState of terminalStates) {
    const mock = createMockFirestore()
    const { gateway, createdOrders } = createGateway()
    mock.set('orders', 'application-order-1', {
      ...mock.get('orders', 'application-order-1'),
      ...terminalState,
    })

    await assert.rejects(
      createRazorpayPaymentOrder(createOrderInput(), {
        ...paymentConfiguration,
        firestore: mock.firestore,
        razorpay: gateway,
      }),
      { code: 'RESERVATION_NOT_PAYABLE' },
    )
    assert.equal(createdOrders.length, 0)
  }
})

test('verified failure releases stock once, then retry reuses the reservation and preserves captured stock', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const failedOrder = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const failedPaymentId = 'pay_retry_failed'
  const failedPayment = {
    id: failedPaymentId,
    order_id: failedOrder.razorpayOrderId,
    amount: failedOrder.amount,
    currency: 'INR',
    status: 'failed',
  }
  payments.set(failedPaymentId, failedPayment)
  const failedInput = {
    razorpay_order_id: failedOrder.razorpayOrderId,
    razorpay_payment_id: failedPaymentId,
    razorpay_signature: signPayment(failedOrder.razorpayOrderId, failedPaymentId),
  }

  const failure = await verifyRazorpayPayment(failedInput, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(failure.status, 'failed')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)

  const writesAfterFailure = mock.updateCount
  assert.deepEqual(await verifyRazorpayPayment(failedInput, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  }), { status: 'failed', duplicate: true })
  assert.equal(mock.updateCount, writesAfterFailure)

  const retryOrder = await createRazorpayPaymentOrder(createOrderInput({
    idempotencyKey: 'checkout-attempt-key-002',
  }), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.notEqual(retryOrder.razorpayOrderId, failedOrder.razorpayOrderId)
  assert.equal(mock.list('orders').length, 1)
  assert.equal(mock.get('orders', 'application-order-1').reservationId, reservationId)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [2, 3],
  )
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, true)

  const capturedPaymentId = 'pay_retry_captured'
  payments.set(capturedPaymentId, {
    id: capturedPaymentId,
    order_id: retryOrder.razorpayOrderId,
    amount: retryOrder.amount,
    currency: 'INR',
    status: 'captured',
  })
  const captured = await verifyRazorpayPayment({
    razorpay_order_id: retryOrder.razorpayOrderId,
    razorpay_payment_id: capturedPaymentId,
    razorpay_signature: signPayment(retryOrder.razorpayOrderId, capturedPaymentId),
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(captured.status, 'captured')
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [3, 0],
  )

  await confirmReservation(reservationId, 'admin-1', {
    firestore: mock.firestore,
    timestamp: { now: () => new Date() },
  })
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [3, 0],
  )
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('checkout dismissal retains an unresolved reservation for the same payment retry', async () => {
  const mock = createMockFirestore({ totalStock: 5, reservedStock: 3, reservedQuantity: 3 })
  const { gateway } = createReconciliationGateway('pending', 7_725)
  let createdOrderCount = 0
  const createProviderOrder = gateway.orders.create
  gateway.orders.create = async (...args) => {
    createdOrderCount += 1
    return createProviderOrder(...args)
  }
  await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const input = {
    reservationId,
    cancellationToken,
    razorpay_order_id: 'order_reconcile1',
  }
  const first = await abandonRazorpayCheckout(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const duplicate = await abandonRazorpayCheckout(input, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const order = mock.get('orders', 'application-order-1')
  const product = mock.get('products', 'product-1')

  assert.deepEqual(first, {
    status: 'pending',
    inventoryStatus: 'held',
    paymentOutcome: 'pending',
    releaseOperationResult: 'retained_pending',
  })
  assert.equal(duplicate.status, first.status)
  assert.equal(duplicate.inventoryStatus, first.inventoryStatus)
  assert.equal(duplicate.releaseOperationResult, 'retained_pending')
  assert.deepEqual([product.totalStock, product.reservedStock, product.availableStock], [5, 3, 2])
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentAttempts[createHashForTest('checkout-attempt-key-001')].status, 'pending')
  assert.notEqual(order.reservationStatus, 'released')
  assert.notEqual(order.checkoutAbandoned, true)
  assert.equal(order.inventoryOwnershipStatus, 'held')
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 0)

  const retryOrder = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(retryOrder.razorpayOrderId, 'order_reconcile1')
  assert.equal(createdOrderCount, 1)
  assert.equal(mock.list('orders').length, 1)
})

test('checkout dismissals retain separate reservations independently', async () => {
  const secondReservationId = 'c26116ca-40bb-4a25-b255-099455ffea4f'
  const secondCancellationToken = 'b'.repeat(64)
  const mock = createMockFirestore({ totalStock: 5, reservedStock: 5, reservedQuantity: 3 })
  mock.set('reservationTokens', secondReservationId, {
    tokenHash: hashCancellationToken(secondCancellationToken),
  })
  mock.set('orders', 'application-order-2', {
    ...mock.get('orders', 'application-order-1'),
    reservationId: secondReservationId,
    reservedQuantity: 2,
  })

  const firstGateway = createReconciliationGateway('pending', 7_725).gateway
  await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: firstGateway,
  })
  const secondGateway = createReconciliationGateway('pending', 5_150).gateway
  await createRazorpayPaymentOrder(createOrderInput({
    reservationId: secondReservationId,
    cancellationToken: secondCancellationToken,
    idempotencyKey: 'checkout-attempt-key-002',
  }), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: secondGateway,
  })

  const firstDismissal = await abandonRazorpayCheckout({
    reservationId,
    cancellationToken,
    razorpay_order_id: 'order_reconcile1',
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: firstGateway,
  })
  assert.equal(firstDismissal.releaseOperationResult, 'retained_pending')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [5, 0],
  )
  assert.equal(mock.get('orders', 'application-order-2').stockReserved, true)

  const secondDismissal = await abandonRazorpayCheckout({
    reservationId: secondReservationId,
    cancellationToken: secondCancellationToken,
    razorpay_order_id: 'order_reconcile1',
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: secondGateway,
  })
  assert.equal(secondDismissal.releaseOperationResult, 'retained_pending')
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [5, 0],
  )
  assert.equal(mock.list('inventoryHistory').length, 0)
})

test('checkout dismissal preserves captured and authorized payment states', async () => {
  for (const paymentStatus of ['captured', 'authorized']) {
    const mock = createMockFirestore()
    const { gateway } = createReconciliationGateway(paymentStatus)
    await createRazorpayPaymentOrder(createOrderInput(), {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    })

    const result = await abandonRazorpayCheckout({
      reservationId,
      cancellationToken,
      razorpay_order_id: 'order_reconcile1',
    }, {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    })
    const order = mock.get('orders', 'application-order-1')
    assert.equal(result.status, paymentStatus)
    assert.equal(result.releaseOperationResult, `protected_${paymentStatus}`)
    assert.equal(order.paymentStatus, paymentStatus)
    assert.notEqual(order.reservationStatus, 'released')
    assert.equal(order.stockReserved, paymentStatus === 'authorized')
    if (paymentStatus === 'captured') {
      assert.equal(order.orderStatus, 'confirmed')
      assert.equal(order.stockDeducted, true)
      assert.deepEqual(
        [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
        [3, 0],
      )
    }
  }
})

test('checkout dismissal retains stock on provider status outage and keeps the attempt unresolved', async () => {
  const mock = createMockFirestore({ totalStock: 5, reservedStock: 3, reservedQuantity: 3 })
  const { gateway: baseGateway } = createReconciliationGateway('pending', 7_725)
  const gateway = {
    ...baseGateway,
    orders: {
      ...baseGateway.orders,
      async fetch() {
        throw new Error('Razorpay is unavailable')
      },
    },
  }
  await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await abandonRazorpayCheckout({
    reservationId,
    cancellationToken,
    razorpay_order_id: 'order_reconcile1',
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const order = mock.get('orders', 'application-order-1')
  assert.equal(result.status, 'pending')
  assert.equal(result.inventoryStatus, 'held')
  assert.equal(order.paymentStatus, 'pending')
  assert.notEqual(order.checkoutAbandoned, true)
  assert.equal(order.paymentAttempts[createHashForTest('checkout-attempt-key-001')].status, 'pending')
  assert.equal(mock.get('products', 'product-1').availableStock, 2)
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 0)
})

test('failure reports require reservation access and a server-fetched failed payment', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const paymentId = 'pay_mock5'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'failed',
  })

  const result = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.equal(result.status, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )

  const repeated = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  assert.deepEqual(repeated, { status: 'failed', duplicate: true })
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)

  await assert.rejects(
    recordRazorpayPaymentFailure({
      reservationId,
      cancellationToken: 'f'.repeat(64),
      razorpay_order_id: order.razorpayOrderId,
      razorpay_payment_id: paymentId,
    }, {
      ...paymentConfiguration,
      firestore: mock.firestore,
      razorpay: gateway,
    }),
    { code: 'INVALID_RESERVATION_TOKEN' },
  )
})

test('server-confirmed failure releases stock after a prior authorization status', async () => {
  const mock = createMockFirestore()
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_authorized_then_failed'
  mock.set('orders', 'application-order-1', {
    ...mock.get('orders', 'application-order-1'),
    paymentStatus: 'authorized',
    paymentAttempts: {
      [createHashForTest('checkout-attempt-key-001')]: {
        ...mock.get('orders', 'application-order-1').paymentAttempts[
          createHashForTest('checkout-attempt-key-001')
        ],
        status: 'authorized',
        paymentId,
      },
    },
  })
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'failed',
  })

  const result = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )
})

test('quantity three failure on four units immediately restores all four units', async () => {
  const mock = createMockFirestore({
    totalStock: 4,
    reservedStock: 3,
    reservedQuantity: 3,
  })
  const { gateway, payments } = createGateway()
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const paymentId = 'pay_three_units_failed'
  payments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: order.amount,
    currency: 'INR',
    status: 'failed',
  })

  const result = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: paymentId,
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'failed')
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [4, 0, 4],
  )
})

test('failure callback without a payment ID immediately reconciles the server-side order', async () => {
  const mock = createMockFirestore()
  const { gateway } = createReconciliationGateway('failed')
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'failed')
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )
})

test('checkout network error cannot downgrade a server-confirmed capture', async () => {
  const mock = createMockFirestore()
  const { gateway } = createReconciliationGateway('captured')
  gateway.payments = {
    async fetch() {
      throw new Error('Simulated payment API network failure.')
    },
  }
  const order = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await recordRazorpayPaymentFailure({
    reservationId,
    cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: 'pay_latecapture',
  }, {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').paymentAttempts[
    createHashForTest('checkout-attempt-key-001')
  ].status, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').orderStatus, 'confirmed')
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)
  assert.equal(mock.get('orders', 'application-order-1').stockDeducted, true)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
})

test('verified Razorpay failure reconciliation restores all reserved inventory', async () => {
  const mock = createMockFirestore()
  const { gateway } = createReconciliationGateway('failed')
  const paymentOrder = await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await reconcileRazorpayReservationPayment(reservationId, {
    firestore: mock.firestore,
    razorpay: gateway,
  })
  const order = mock.get('orders', 'application-order-1')
  const product = mock.get('products', 'product-1')

  assert.equal(paymentOrder.razorpayOrderId, 'order_reconcile1')
  assert.equal(result.status, 'failed')
  assert.equal(order.paymentStatus, 'failed')
  assert.equal(order.stockReserved, false)
  assert.deepEqual([product.totalStock, product.reservedStock, product.availableStock], [5, 0, 5])
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
})

test('pending payment reconciliation keeps reserved stock held', async () => {
  const mock = createMockFirestore()
  const { gateway } = createReconciliationGateway('pending')
  await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await reconcileRazorpayReservationPayment(reservationId, {
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'pending')
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, true)
  assert.equal(mock.get('products', 'product-1').reservedStock, 2)
})

test('captured payment discovered during reconciliation is preserved without releasing stock', async () => {
  const mock = createMockFirestore()
  const { gateway } = createReconciliationGateway('captured')
  await createRazorpayPaymentOrder(createOrderInput(), {
    ...paymentConfiguration,
    firestore: mock.firestore,
    razorpay: gateway,
  })

  const result = await reconcileRazorpayReservationPayment(reservationId, {
    firestore: mock.firestore,
    razorpay: gateway,
  })

  assert.equal(result.status, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'captured')
  assert.equal(mock.get('orders', 'application-order-1').orderStatus, 'confirmed')
  assert.equal(mock.get('orders', 'application-order-1').stockDeducted, true)
  assert.deepEqual([mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock], [3, 0])
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 0)
})

function createHashForTest(value) {
  return createHash('sha256').update(value).digest('hex')
}
