import assert from 'node:assert/strict'
import test from 'node:test'
import handler from '../api/admin/orders.js'

function createTimestamp(milliseconds = Date.now()) {
  return {
    toDate: () => new Date(milliseconds),
    toMillis: () => milliseconds,
    toISOString: () => new Date(milliseconds).toISOString(),
  }
}

function createMockFirestore(seed) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [
      name,
      new Map(Object.entries(documents).map(([id, value]) => [id, { ...value }])),
    ]),
  )
  let nextId = 0
  let transactionCount = 0

  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const createRef = (name, id) => ({
    collectionName: name,
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
                    .map(([id]) => createRef(name, id))
                  return {
                    docs: docs.map((ref) => ({ id: ref.id, ref, data: () => getSnapshot(ref).data() })),
                    empty: docs.length === 0,
                  }
                },
              }
            },
          }
        },
      }
    },
    async runTransaction(work) {
      transactionCount += 1
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
    },
  }

  return {
    firestore,
    get(name, id) {
      const value = getCollection(name).get(id)
      return value && { ...value }
    },
    list(name) {
      return [...getCollection(name).values()].map((value) => ({ ...value }))
    },
    get transactionCount() {
      return transactionCount
    },
  }
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
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

function createReservationFixture() {
  return createMockFirestore({
    orders: {
      'order-1': {
        orderStatus: 'initiated',
        reservationId: 'reservation-1',
        reservationStatus: 'active',
        productId: 'product-1',
        reservedQuantity: 2,
        stockDeducted: false,
        stockRestored: false,
        paymentStatus: 'pending',
      },
    },
    products: {
      'product-1': {
        name: 'Test saree',
        totalStock: 10,
        reservedStock: 2,
        availableStock: 8,
        inStock: true,
        lowStockThreshold: 2,
      },
    },
  })
}

async function postOrderStatus(mock, orderStatus, { authenticateAdmin, timestamp } = {}) {
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body: { action: 'status', orderId: 'order-1', orderStatus },
  }, response, {
    firestore: mock.firestore,
    authenticateAdmin,
    timestamp: timestamp || { now: () => createTimestamp() },
  })
  return response
}

const authenticatedAdmin = async () => ({ uid: 'admin-1' })

test('admin cannot confirm an unpaid order', async () => {
  const mock = createReservationFixture()
  const response = await postOrderStatus(mock, 'confirmed', {
    authenticateAdmin: authenticatedAdmin,
  })
  assert.equal(response.statusCode, 409)
  assert.equal(mock.get('orders', 'order-1').orderStatus, 'initiated')
  assert.equal(mock.get('products', 'product-1').totalStock, 10)
  assert.equal(mock.list('inventoryHistory').length, 0)
})

test('paid orders can be advanced through fulfillment without changing inventory', async () => {
  const mock = createMockFirestore({
    orders: {
      'order-1': {
        orderStatus: 'confirmed',
        reservationId: 'reservation-1',
        reservationStatus: 'converted',
        productId: 'product-1',
        reservedQuantity: 2,
        stockDeducted: true,
        stockRestored: false,
        paymentMethod: 'razorpay',
        paymentStatus: 'captured',
      },
    },
    products: {
      'product-1': { totalStock: 8, reservedStock: 0, availableStock: 8 },
    },
  })
  const initialInventory = mock.get('products', 'product-1')
  const processing = await postOrderStatus(mock, 'processing', { authenticateAdmin: authenticatedAdmin })
  assert.equal(processing.statusCode, 200)
  assert.equal(mock.get('orders', 'order-1').orderStatus, 'processing')
  const shipped = await postOrderStatus(mock, 'shipped', { authenticateAdmin: authenticatedAdmin })
  assert.equal(shipped.statusCode, 200)
  const delivered = await postOrderStatus(mock, 'delivered', { authenticateAdmin: authenticatedAdmin })
  assert.equal(delivered.statusCode, 200)
  assert.equal(mock.get('orders', 'order-1').orderStatus, 'delivered')
  assert.deepEqual(mock.get('products', 'product-1'), initialInventory)
})

test('captured order cancellation requires a processed refund', async () => {
  const mock = createMockFirestore({
    orders: {
      'order-1': {
        orderStatus: 'confirmed',
        paymentMethod: 'razorpay',
        paymentStatus: 'captured',
        refundStatus: 'requested',
      },
    },
  })
  const response = await postOrderStatus(mock, 'cancelled', { authenticateAdmin: authenticatedAdmin })
  assert.equal(response.statusCode, 409)
  assert.equal(mock.get('orders', 'order-1').orderStatus, 'confirmed')
})

test('cancelled and restocked reservations cannot be marked completed', async () => {
  const restockedOrders = [
    { orderStatus: 'cancelled', stockRestored: true },
    { orderStatus: 'confirmed', stockRestored: true },
  ]

  for (const orderState of restockedOrders) {
    const mock = createMockFirestore({
      orders: {
        'order-1': {
          ...orderState,
          reservationId: 'reservation-1',
          reservationStatus: 'converted',
          stockDeducted: true,
        },
      },
    })

    const response = await postOrderStatus(mock, 'completed', {
      authenticateAdmin: authenticatedAdmin,
    })

    assert.equal(response.statusCode, 409)
    assert.equal(mock.get('orders', 'order-1').orderStatus, orderState.orderStatus)
    assert.equal(mock.get('orders', 'order-1').stockRestored, true)
  }
})

test('unauthorized users cannot update an order status', async () => {
  const mock = createReservationFixture()
  const response = await postOrderStatus(mock, 'completed')

  assert.equal(response.statusCode, 401)
  assert.equal(mock.get('orders', 'order-1').orderStatus, 'initiated')
  assert.equal(mock.transactionCount, 0)
})
