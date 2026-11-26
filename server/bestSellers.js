import { performance } from 'node:perf_hooks'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'

const db = getFirestore()
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 5 * 60 * 1000
const ORDER_SALES_FIELDS = [
  'createdAt',
  'orderStatus',
  'paymentMethod',
  'paymentStatus',
  'productId',
  'productName',
  'orderItems',
  'items',
  'products',
  'reservedQuantity',
  'quantity',
  'price',
  'unitPrice',
  'paymentAmountPaise',
  'refundAmountPaise',
  'refundRequired',
  'refundStatus',
  'archived',
  'deleted',
  'deletedAt',
  'stockRestored',
]
const ELIGIBLE_ORDER_STATUSES = new Set([
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'completed',
])
const OPEN_REFUND_STATUSES = new Set(['requested', 'pending'])

function startTiming(onTiming) {
  return typeof onTiming === 'function' ? performance.now() : null
}

function recordTimingValue(onTiming, name, durationMs, description) {
  if (typeof onTiming !== 'function') return
  onTiming({
    name,
    durationMs: Math.max(0, Number(durationMs) || 0),
    ...(description ? { description } : {}),
  })
}

function recordTiming(onTiming, name, startedAt, description) {
  if (startedAt === null) return
  recordTimingValue(onTiming, name, performance.now() - startedAt, description)
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toTimestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value?.toDate === 'function') return value.toDate().getTime()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const milliseconds = new Date(value).getTime()
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function getOrderLines(order) {
  const storedItems = [order.orderItems, order.items, order.products]
    .find((value) => Array.isArray(value) && value.length)
  const sourceItems = storedItems || [{
    productId: order.productId,
    productName: order.productName,
    quantity: order.reservedQuantity ?? order.quantity,
    unitPrice: order.price ?? order.unitPrice,
  }]

  return sourceItems.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const productId = typeof (item.productId || item.id) === 'string'
      ? String(item.productId || item.id).trim()
      : ''
    const quantity = toFiniteNumber(item.quantity ?? item.reservedQuantity)
    const listedPrice = toFiniteNumber(item.unitPrice ?? item.price)
    const subtotal = toFiniteNumber(item.lineSubtotal ?? item.subtotal ?? item.lineTotal)
    const unitPrice = listedPrice ?? (quantity > 0 && subtotal !== null ? subtotal / quantity : null)
    if (
      !productId
      || productId.includes('/')
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
      || unitPrice === null
      || unitPrice < 0
    ) {
      return []
    }

    return [{
      productId,
      productName: typeof (item.productName || item.name) === 'string'
        ? String(item.productName || item.name).trim()
        : '',
      quantity,
      unitPrice,
    }]
  })
}

function isFullyRefunded(order) {
  if (order.paymentStatus === 'refunded') return true
  if (order.refundStatus !== 'processed') return false
  const paidPaise = toFiniteNumber(order.paymentAmountPaise)
  const refundedPaise = toFiniteNumber(order.refundAmountPaise)
  return Number.isSafeInteger(paidPaise)
    && Number.isSafeInteger(refundedPaise)
    && paidPaise > 0
    && refundedPaise >= paidPaise
}

function getProcessedRefundPaise(order) {
  if (order.refundStatus !== 'processed') return 0
  const refundedPaise = toFiniteNumber(order.refundAmountPaise)
  return Number.isSafeInteger(refundedPaise) && refundedPaise > 0 ? refundedPaise : 0
}

function getRefundedSingleItemQuantity(order, line) {
  const refundPaise = getProcessedRefundPaise(order)
  const unitPricePaise = Math.round(line.unitPrice * 100)
  const paymentAmountPaise = toFiniteNumber(order.paymentAmountPaise)
  if (
    refundPaise <= 0
    || unitPricePaise <= 0
    || paymentAmountPaise !== unitPricePaise * line.quantity
    || refundPaise % unitPricePaise !== 0
  ) {
    return 0
  }
  return Math.min(line.quantity, refundPaise / unitPricePaise)
}

function isEligibleOrder(order, cutoffMs) {
  if (
    order.paymentMethod !== 'razorpay'
    || order.paymentStatus !== 'captured'
    || !ELIGIBLE_ORDER_STATUSES.has(order.orderStatus)
    || order.archived === true
    || order.deleted === true
    || order.deletedAt != null
    || order.stockRestored === true
    || isFullyRefunded(order)
    || OPEN_REFUND_STATUSES.has(order.refundStatus)
    || (order.refundRequired === true && order.refundStatus !== 'processed' && order.refundStatus !== 'failed')
  ) {
    return false
  }

  if (cutoffMs === null) return true
  const createdAt = toTimestampMillis(order.createdAt)
  return createdAt !== null && createdAt >= cutoffMs
}

function compareSales(left, right) {
  return right.unitsSold - left.unitsSold
    || right.revenuePaise - left.revenuePaise
    || left.productName.localeCompare(right.productName, 'en', { sensitivity: 'base' })
    || left.productId.localeCompare(right.productId)
}

export function aggregateEligibleSales(orderDocuments, {
  cutoffMs = null,
  onTiming,
  timingPrefix = 'sales',
} = {}) {
  const aggregationStartedAt = startTiming(onTiming)
  const salesByProduct = new Map()
  const seenOrderIds = new Set()

  for (const document of orderDocuments) {
    const orderId = document?.id
    if (typeof orderId === 'string' && seenOrderIds.has(orderId)) continue
    if (typeof orderId === 'string') seenOrderIds.add(orderId)
    const order = typeof document?.data === 'function' ? document.data() : document
    if (!order || !isEligibleOrder(order, cutoffMs)) continue

    const lines = getOrderLines(order)
    if (!lines.length) continue
    const totalGrossPaise = lines.reduce(
      (total, line) => total + Math.round(line.unitPrice * 100) * line.quantity,
      0,
    )
    const refundPaise = Math.min(getProcessedRefundPaise(order), totalGrossPaise)
    const singleProductLine = lines.length === 1 ? lines[0] : null

    for (const line of lines) {
      const refundedQuantity = singleProductLine
        ? getRefundedSingleItemQuantity(order, line)
        : 0
      const unitsSold = line.quantity - refundedQuantity
      if (unitsSold <= 0) continue
      const lineGrossPaise = Math.round(line.unitPrice * 100) * line.quantity
      const lineRefundPaise = singleProductLine && refundedQuantity > 0
        ? 0
        : totalGrossPaise > 0
          ? Math.round(refundPaise * lineGrossPaise / totalGrossPaise)
          : 0
      const revenuePaise = Math.max(
        0,
        Math.round(line.unitPrice * 100) * unitsSold - lineRefundPaise,
      )
      const current = salesByProduct.get(line.productId) || {
        productId: line.productId,
        productName: line.productName || order.productName || '',
        unitsSold: 0,
        revenuePaise: 0,
      }
      current.unitsSold += unitsSold
      current.revenuePaise += revenuePaise
      if (!current.productName && (line.productName || order.productName)) {
        current.productName = line.productName || order.productName
      }
      salesByProduct.set(line.productId, current)
    }
  }

  const eligibleSales = [...salesByProduct.values()]
    .filter((sale) => sale.unitsSold > 0)
  recordTiming(onTiming, `${timingPrefix}_aggregation`, aggregationStartedAt)

  const rankingStartedAt = startTiming(onTiming)
  eligibleSales.sort(compareSales)
  recordTiming(onTiming, `${timingPrefix}_sales_ranking`, rankingStartedAt)
  return eligibleSales
}

function getAvailableStock(product) {
  const totalStock = Number.isSafeInteger(product.totalStock) && product.totalStock >= 0
    ? product.totalStock
    : 0
  const reservedStock = Number.isSafeInteger(product.reservedStock) && product.reservedStock >= 0
    ? Math.min(totalStock, product.reservedStock)
    : 0
  return Math.max(0, totalStock - reservedStock)
}

async function retainAvailableProducts(firestore, sales, {
  onTiming,
  timingPrefix,
} = {}) {
  if (!sales.length) {
    recordTimingValue(onTiming, `${timingPrefix}_product_reads`, 0)
    recordTimingValue(onTiming, `${timingPrefix}_product_processing`, 0)
    recordTimingValue(onTiming, `${timingPrefix}_product_ranking`, 0)
    return []
  }

  const availableSales = []
  let productReadDurationMs = 0
  let productProcessingDurationMs = 0
  try {
    for (let index = 0; index < sales.length; index += 100) {
      const batch = sales.slice(index, index + 100)
      const references = batch.map(({ productId }) => firestore.collection('products').doc(productId))
      const readStartedAt = startTiming(onTiming)
      let snapshots
      try {
        snapshots = await firestore.getAll(...references)
      } finally {
        if (readStartedAt !== null) {
          productReadDurationMs += performance.now() - readStartedAt
        }
      }

      const processingStartedAt = startTiming(onTiming)
      try {
        snapshots.forEach((snapshot, offset) => {
          if (!snapshot.exists) return
          const product = snapshot.data()
          if (product.deleted === true || product.archived === true || getAvailableStock(product) <= 0) return
          availableSales.push({
            ...batch[offset],
            productName: typeof product.name === 'string' && product.name.trim()
              ? product.name.trim()
              : batch[offset].productName,
          })
        })
      } finally {
        if (processingStartedAt !== null) {
          productProcessingDurationMs += performance.now() - processingStartedAt
        }
      }
    }
  } finally {
    recordTimingValue(onTiming, `${timingPrefix}_product_reads`, productReadDurationMs)
    recordTimingValue(onTiming, `${timingPrefix}_product_processing`, productProcessingDurationMs)
  }

  const rankingStartedAt = startTiming(onTiming)
  availableSales.sort(compareSales)
  recordTiming(onTiming, `${timingPrefix}_product_ranking`, rankingStartedAt)
  return availableSales
}

async function readSalesOrders(firestore, { timestamp, cutoffMs }) {
  let orderQuery = firestore.collection('orders')
  orderQuery = cutoffMs === null
    ? orderQuery.where('paymentStatus', '==', 'captured')
    : orderQuery.where('createdAt', '>=', timestamp.fromMillis(cutoffMs))
  const snapshot = await orderQuery.select(...ORDER_SALES_FIELDS).get()
  return snapshot.docs
}

export function createBestSellerService({
  firestore = db,
  timestamp = Timestamp,
  clock = Date.now,
  cacheTtlMs = CACHE_TTL_MS,
} = {}) {
  let cachedProductIds = null
  let cacheExpiresAt = 0
  let inFlight = null

  async function loadProductIds(onTiming) {
    const cutoffMs = clock() - NINETY_DAYS_MS
    const recentQueryStartedAt = startTiming(onTiming)
    const recentOrders = await readSalesOrders(firestore, { timestamp, cutoffMs })
    recordTiming(onTiming, 'recent_orders_query', recentQueryStartedAt)
    const recentSales = aggregateEligibleSales(recentOrders, {
      cutoffMs,
      onTiming,
      timingPrefix: 'recent',
    })
    let availableSales = await retainAvailableProducts(firestore, recentSales, {
      onTiming,
      timingPrefix: 'recent',
    })

    if (availableSales.length < 3) {
      const lifetimeQueryStartedAt = startTiming(onTiming)
      const lifetimeOrders = await readSalesOrders(firestore, { timestamp, cutoffMs: null })
      recordTiming(onTiming, 'lifetime_fallback_query', lifetimeQueryStartedAt)
      const lifetimeSales = aggregateEligibleSales(lifetimeOrders, {
        onTiming,
        timingPrefix: 'lifetime',
      })
      availableSales = await retainAvailableProducts(firestore, lifetimeSales, {
        onTiming,
        timingPrefix: 'lifetime',
      })
    }

    return availableSales.map(({ productId }) => productId)
  }

  return async function getBestSellerProductIds({ forceRefresh = false, onTiming } = {}) {
    const serviceStartedAt = startTiming(onTiming)
    const cacheCheckStartedAt = startTiming(onTiming)
    const currentTime = clock()
    if (!forceRefresh && cachedProductIds && cacheExpiresAt > currentTime) {
      recordTiming(onTiming, 'cache', cacheCheckStartedAt, 'hit')
      recordTiming(onTiming, 'best_sellers_service', serviceStartedAt)
      return [...cachedProductIds]
    }
    if (!forceRefresh && inFlight) {
      const inFlightWaitStartedAt = startTiming(onTiming)
      try {
        return [...await inFlight]
      } finally {
        recordTiming(onTiming, 'in_flight_wait', inFlightWaitStartedAt)
        recordTiming(onTiming, 'cache', cacheCheckStartedAt, 'in-flight')
        recordTiming(onTiming, 'best_sellers_service', serviceStartedAt)
      }
    }

    recordTiming(onTiming, 'cache', cacheCheckStartedAt, 'miss')
    inFlight = loadProductIds(onTiming)
    try {
      const productIds = await inFlight
      cachedProductIds = productIds
      cacheExpiresAt = clock() + cacheTtlMs
      return [...productIds]
    } finally {
      recordTiming(onTiming, 'best_sellers_service', serviceStartedAt)
      inFlight = null
    }
  }
}

export const getBestSellerProductIds = createBestSellerService()
