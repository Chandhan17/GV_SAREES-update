import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateEligibleSales,
  createBestSellerService,
} from '../server/bestSellers.js'

const NOW = new Date('2026-11-25T00:00:00.000Z').getTime()
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

function orderDocument(id, overrides = {}) {
  const order = {
    createdAt: new Date(NOW),
    orderStatus: 'confirmed',
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
    productId: id,
    productName: id,
    reservedQuantity: 1,
    price: 100,
    paymentAmountPaise: 10_000,
    refundStatus: 'none',
    ...overrides,
  }
  return { id, data: () => order }
}

function createMockFirestore(orders, products) {
  let orderQueryCount = 0
  const getOrder = (document) => typeof document.data === 'function' ? document.data() : document
  const buildOrdersQuery = (filters = []) => ({
    where(field, operator, value) {
      return buildOrdersQuery([...filters, { field, operator, value }])
    },
    select() {
      return this
    },
    async get() {
      orderQueryCount += 1
      const docs = orders.filter((document) => {
        const order = getOrder(document)
        return filters.every(({ field, operator, value }) => {
          if (operator === '==') return order[field] === value
          if (operator === '>=') return new Date(order[field]).getTime() >= value.getTime()
          return false
        })
      })
      return { docs }
    },
  })

  return {
    collection(name) {
      if (name === 'orders') return { where: (...args) => buildOrdersQuery().where(...args) }
      if (name === 'products') {
        return { doc: (id) => ({ id }) }
      }
      throw new Error(`Unexpected collection: ${name}`)
    },
    async getAll(...references) {
      return references.map(({ id }) => {
        const product = products.get(id)
        return {
          exists: Boolean(product),
          data: () => product,
        }
      })
    },
    get orderQueryCount() {
      return orderQueryCount
    },
  }
}

const testTimestamp = { fromMillis: (milliseconds) => new Date(milliseconds) }

test('ranks products by eligible units sold and then eligible sales revenue', () => {
  const orders = [
    orderDocument('silk-order-1', { productId: 'silk', reservedQuantity: 2, price: 100, paymentAmountPaise: 20_000 }),
    orderDocument('cotton', { reservedQuantity: 3, price: 50, paymentAmountPaise: 15_000 }),
    orderDocument('silk-order-2', { productId: 'silk', reservedQuantity: 2, price: 100, paymentAmountPaise: 20_000 }),
  ]

  assert.deepEqual(
    aggregateEligibleSales(orders).map(({ productId, unitsSold }) => [productId, unitsSold]),
    [['silk', 4], ['cotton', 3]],
  )
})

test('aggregates the legacy multi-item order arrays without using order-level quantity for each item', () => {
  const [silk, cotton] = aggregateEligibleSales([
    orderDocument('legacy-order', {
      productId: 'legacy-fallback',
      reservedQuantity: 99,
      orderItems: [
        { productId: 'silk', productName: 'Silk Saree', quantity: 2, unitPrice: 100 },
        { productId: 'cotton', productName: 'Cotton Saree', quantity: 1, unitPrice: 50 },
      ],
    }),
  ])

  assert.deepEqual([silk.productId, silk.unitsSold], ['silk', 2])
  assert.deepEqual([cotton.productId, cotton.unitsSold], ['cotton', 1])
})

test('counts captured confirmed and delivered purchases but excludes unpaid and cancelled orders', () => {
  const orders = [
    orderDocument('confirmed'),
    orderDocument('delivered', { orderStatus: 'delivered' }),
    orderDocument('processing', { orderStatus: 'processing' }),
    orderDocument('initiated', { orderStatus: 'initiated' }),
    orderDocument('cancelled', { orderStatus: 'cancelled' }),
    orderDocument('pending', { paymentStatus: 'pending' }),
    orderDocument('failed', { paymentStatus: 'failed' }),
    orderDocument('other-payment', { paymentMethod: 'cash' }),
  ]

  assert.deepEqual(
    aggregateEligibleSales(orders).map(({ productId }) => productId),
    ['confirmed', 'delivered', 'processing'],
  )
})

test('fully refunded purchases are excluded and exact per-unit refunds reduce eligible quantity', () => {
  const orders = [
    orderDocument('fully-refunded', {
      reservedQuantity: 3,
      paymentAmountPaise: 30_000,
      refundStatus: 'processed',
      refundAmountPaise: 30_000,
    }),
    orderDocument('partially-refunded', {
      reservedQuantity: 3,
      paymentAmountPaise: 30_000,
      refundStatus: 'processed',
      refundAmountPaise: 10_000,
    }),
  ]

  const [sale] = aggregateEligibleSales(orders)
  assert.equal(sale.productId, 'partially-refunded')
  assert.equal(sale.unitsSold, 2)
  assert.equal(sale.revenuePaise, 20_000)
})

test('a partial refund without an exact unit-quantity match reduces revenue but does not guess returned units', () => {
  const [sale] = aggregateEligibleSales([
    orderDocument('partial-currency-refund', {
      reservedQuantity: 2,
      paymentAmountPaise: 20_000,
      refundStatus: 'processed',
      refundAmountPaise: 5_000,
    }),
  ])

  assert.equal(sale.unitsSold, 2)
  assert.equal(sale.revenuePaise, 15_000)
})

test('does not infer refunded units when the recorded payment amount disagrees with product total', () => {
  const [sale] = aggregateEligibleSales([
    orderDocument('non-matching-payment', {
      reservedQuantity: 2,
      paymentAmountPaise: 21_000,
      refundStatus: 'processed',
      refundAmountPaise: 10_000,
    }),
  ])

  assert.equal(sale.unitsSold, 2)
  assert.equal(sale.revenuePaise, 10_000)
})

test('duplicate webhook processing does not count the same order document twice', () => {
  const order = orderDocument('single-order', { reservedQuantity: 2 })

  assert.equal(aggregateEligibleSales([order, order])[0].unitsSold, 2)
})

test('archived, deleted, restored, and unresolved-refund orders are excluded', () => {
  const orders = [
    orderDocument('archived', { archived: true }),
    orderDocument('deleted', { deleted: true }),
    orderDocument('deleted-at', { deletedAt: new Date(NOW) }),
    orderDocument('restored', { stockRestored: true }),
    orderDocument('refund-requested', { refundRequired: true, refundStatus: 'requested' }),
  ]

  assert.deepEqual(aggregateEligibleSales(orders), [])
})

test('ties use revenue and then product name for deterministic ordering', () => {
  const orders = [
    orderDocument('a', { productName: 'Zulu', reservedQuantity: 2, price: 100 }),
    orderDocument('b', { productName: 'Beta', reservedQuantity: 2, price: 150 }),
    orderDocument('c', { productName: 'Alpha', reservedQuantity: 2, price: 100 }),
  ]

  assert.deepEqual(
    aggregateEligibleSales(orders).map(({ productId }) => productId),
    ['b', 'c', 'a'],
  )
})

test('the 90-day cutoff uses the order creation timestamp and includes its boundary', () => {
  const cutoff = NOW - NINETY_DAYS_MS
  const orders = [
    orderDocument('boundary', { createdAt: new Date(cutoff) }),
    orderDocument('older', { createdAt: new Date(cutoff - 1) }),
    orderDocument('missing-date', { createdAt: null }),
  ]

  assert.deepEqual(
    aggregateEligibleSales(orders, { cutoffMs: cutoff }).map(({ productId }) => productId),
    ['boundary'],
  )
})

test('falls back to lifetime sales when fewer than three recent products are available', async () => {
  const products = new Map(['recent-a', 'recent-b', 'older-best'].map((id) => [
    id,
    { name: id, totalStock: 5, reservedStock: 0 },
  ]))
  const firestore = createMockFirestore([
    orderDocument('recent-a', { reservedQuantity: 2 }),
    orderDocument('recent-b', { reservedQuantity: 1 }),
    orderDocument('older-best', {
      reservedQuantity: 5,
      createdAt: new Date(NOW - NINETY_DAYS_MS - 1),
    }),
  ], products)
  const getBestSellerProductIds = createBestSellerService({
    firestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })

  assert.deepEqual(await getBestSellerProductIds(), ['older-best', 'recent-a', 'recent-b'])
  assert.equal(firestore.orderQueryCount, 2)
})

test('records read-only stage timings for recent and lifetime fallback rankings', async () => {
  const products = new Map(['recent-a', 'recent-b', 'older-best'].map((id) => [
    id,
    { name: id, totalStock: 5, reservedStock: 0 },
  ]))
  const firestore = createMockFirestore([
    orderDocument('recent-a', { reservedQuantity: 2 }),
    orderDocument('recent-b', { reservedQuantity: 1 }),
    orderDocument('older-best', {
      reservedQuantity: 5,
      createdAt: new Date(NOW - NINETY_DAYS_MS - 1),
    }),
  ], products)
  const getBestSellerProductIds = createBestSellerService({
    firestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })
  const timings = []

  assert.deepEqual(await getBestSellerProductIds({
    onTiming: (timing) => timings.push(timing),
  }), ['older-best', 'recent-a', 'recent-b'])
  assert.deepEqual(
    timings.filter(({ name }) => name === 'cache').map(({ description }) => description),
    ['miss'],
  )

  for (const name of [
    'recent_orders_query',
    'recent_aggregation',
    'recent_sales_ranking',
    'recent_product_reads',
    'recent_product_processing',
    'recent_product_ranking',
    'lifetime_fallback_query',
    'lifetime_aggregation',
    'lifetime_sales_ranking',
    'lifetime_product_reads',
    'lifetime_product_processing',
    'lifetime_product_ranking',
    'best_sellers_service',
  ]) {
    const timing = timings.find((item) => item.name === name)
    assert.ok(timing, `expected ${name} timing`)
    assert.ok(Number.isFinite(timing.durationMs) && timing.durationMs >= 0)
  }
})

test('records cache hits and in-flight reuse without repeating query work', async () => {
  const firestore = createMockFirestore([], new Map())
  const getBestSellerProductIds = createBestSellerService({
    firestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })
  const missTimings = []
  const hitTimings = []

  assert.deepEqual(await getBestSellerProductIds({
    onTiming: (timing) => missTimings.push(timing),
  }), [])
  assert.deepEqual(await getBestSellerProductIds({
    onTiming: (timing) => hitTimings.push(timing),
  }), [])
  assert.equal(hitTimings.find(({ name }) => name === 'cache')?.description, 'hit')
  assert.equal(hitTimings.some(({ name }) => name === 'recent_orders_query'), false)

  const inFlightFirestore = createMockFirestore([], new Map())
  const inFlightService = createBestSellerService({
    firestore: inFlightFirestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })
  const waitingTimings = []
  const firstRequest = inFlightService()
  const secondRequest = inFlightService({
    onTiming: (timing) => waitingTimings.push(timing),
  })
  assert.deepEqual(await firstRequest, [])
  assert.deepEqual(await secondRequest, [])
  assert.equal(waitingTimings.find(({ name }) => name === 'cache')?.description, 'in-flight')
  assert.ok(waitingTimings.some(({ name }) => name === 'in_flight_wait'))
  assert.equal(inFlightFirestore.orderQueryCount, 2)
})

test('uses recent rankings when at least three eligible products have sales in the period', async () => {
  const products = new Map(['recent-a', 'recent-b', 'recent-c', 'older-best'].map((id) => [
    id,
    { name: id, totalStock: 5, reservedStock: 0 },
  ]))
  const firestore = createMockFirestore([
    orderDocument('recent-a', { reservedQuantity: 2 }),
    orderDocument('recent-b'),
    orderDocument('recent-c'),
    orderDocument('older-best', {
      reservedQuantity: 20,
      createdAt: new Date(NOW - NINETY_DAYS_MS - 1),
    }),
  ], products)
  const getBestSellerProductIds = createBestSellerService({
    firestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })

  assert.deepEqual(await getBestSellerProductIds(), ['recent-a', 'recent-b', 'recent-c'])
  assert.equal(firestore.orderQueryCount, 1)
})

test('omits missing, deleted, and out-of-stock products from the public ranking', async () => {
  const products = new Map([
    ['available', { name: 'Available', totalStock: 3, reservedStock: 1 }],
    ['deleted-flag', { name: 'Deleted', totalStock: 3, reservedStock: 0, deleted: true }],
    ['unavailable', { name: 'Unavailable', totalStock: 2, reservedStock: 2 }],
  ])
  const firestore = createMockFirestore([
    orderDocument('available'),
    orderDocument('deleted-flag'),
    orderDocument('unavailable'),
    orderDocument('missing'),
  ], products)
  const getBestSellerProductIds = createBestSellerService({
    firestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })

  assert.deepEqual(await getBestSellerProductIds(), ['available'])
})

test('returns no products when no eligible sales exist and caches successful rankings', async () => {
  const emptyFirestore = createMockFirestore([], new Map())
  const getEmptyRanking = createBestSellerService({
    firestore: emptyFirestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })
  assert.deepEqual(await getEmptyRanking(), [])

  const populatedFirestore = createMockFirestore(
    [orderDocument('cached', { reservedQuantity: 2 })],
    new Map([['cached', { name: 'Cached', totalStock: 2, reservedStock: 0 }]]),
  )
  const getCachedRanking = createBestSellerService({
    firestore: populatedFirestore,
    timestamp: testTimestamp,
    clock: () => NOW,
  })
  assert.deepEqual(await getCachedRanking(), ['cached'])
  assert.deepEqual(await getCachedRanking(), ['cached'])
  assert.equal(populatedFirestore.orderQueryCount, 2)
})
