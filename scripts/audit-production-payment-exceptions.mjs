/**
 * READ-ONLY — NO FIRESTORE WRITES
 *
 * This diagnostic reuses the application's Firebase Admin initialization and
 * performs bounded Firestore reads only. It does not call Razorpay, Telegram,
 * or any other external API.
 */
import { createHash } from 'node:crypto'
import process from 'node:process'
import { getApps } from 'firebase-admin/app'

const REQUIRED_PROJECT_ID = 'gv-sarees'
const PAGE_SIZE = 250
const MAX_DOCUMENTS_PER_COLLECTION = 100000
const MAX_HASHED_REFERENCES_PER_CATEGORY = 300
const EMULATOR_ENVIRONMENT_VARIABLES = [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'FIREBASE_EMULATOR_HUB',
  'VITE_FIRESTORE_EMULATOR_HOST',
  'VITE_FIREBASE_AUTH_EMULATOR_HOST',
]
const ORDER_FIELDS = [
  'reservationStatus',
  'expiresAt',
  'stockReserved',
  'stockDeducted',
  'stockRestored',
  'inventoryOwnershipStatus',
  'paymentMethod',
  'paymentStatus',
  'paymentReconciliationStatus',
  'refundRequired',
  'refundStatus',
  'orderStatus',
  'paymentAttempts',
  'items',
  'orderItems',
  'products',
  'productId',
  'reservedQuantity',
]
const PRODUCT_FIELDS = ['totalStock', 'reservedStock']
const ORDER_CATEGORIES = [
  'capturedAndFulfilled',
  'capturedAwaitingFulfillment',
  'capturedRequiringReconciliation',
  'refundRequired',
  'refundProcessed',
  'pendingPayment',
  'authorizedPayment',
  'manualReview',
  'unresolvedPayment',
  'reservationInventoryInconsistency',
]
const ATTEMPT_CATEGORIES = [
  'pending',
  'authorized',
  'failed',
  'captured',
  'unknownOrInconsistent',
  'unresolved',
]
const EFFECTIVE_ATTEMPT_STATUSES = new Set(['pending', 'authorized', 'captured', 'failed'])
const KNOWN_ATTEMPT_STATUSES = new Set([
  'creating',
  'pending',
  'authorized',
  'captured',
  'failed',
])
const KNOWN_PAYMENT_STATUSES = new Set([
  'created',
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
])
const RECONCILIATION_STATUSES = new Set(['pending', 'manual_review'])

function assertNoEmulatorConfiguration() {
  const emulatorVariables = EMULATOR_ENVIRONMENT_VARIABLES.filter((name) => (
    typeof process.env[name] === 'string' && process.env[name].trim() !== ''
  ))
  if (emulatorVariables.length) {
    throw new Error('Emulator configuration is present; production audit aborted.')
  }
  if (process.env.APP_MODE === 'performance' || process.env.TELEGRAM_TEST_MODE === '1') {
    throw new Error('Performance/test mode is enabled; production audit aborted.')
  }
}

function getFirebaseConfigProjectId() {
  const rawConfig = process.env.FIREBASE_CONFIG
  if (!rawConfig || !rawConfig.trim().startsWith('{')) return null

  let config
  try {
    config = JSON.parse(rawConfig)
  } catch {
    throw new Error('FIREBASE_CONFIG is invalid; project identity cannot be verified.')
  }

  return typeof config?.projectId === 'string' ? config.projectId : null
}

async function verifyProjectId(app) {
  const credential = app.options.credential
  const projectSources = [
    ['Firebase Admin app options', app.options.projectId],
    ['Firebase Admin credential', credential?.projectId],
    ['GOOGLE_CLOUD_PROJECT', process.env.GOOGLE_CLOUD_PROJECT],
    ['GCLOUD_PROJECT', process.env.GCLOUD_PROJECT],
  ].filter(([, value]) => typeof value === 'string' && value.trim() !== '')
  const configuredHints = [
    ['FIREBASE_PROJECT_ID', process.env.FIREBASE_PROJECT_ID],
    ['FIREBASE_CONFIG', getFirebaseConfigProjectId()],
  ].filter(([, value]) => typeof value === 'string' && value.trim() !== '')

  if ([...projectSources, ...configuredHints].some(([, value]) => value !== REQUIRED_PROJECT_ID)) {
    throw new Error('Configured project identity does not match gv-sarees; audit aborted.')
  }

  let resolvedProjectId = projectSources.length ? projectSources[0][1] : null
  if (!resolvedProjectId && typeof credential?.getProjectId === 'function') {
    try {
      resolvedProjectId = await credential.getProjectId()
    } catch {
      throw new Error('Firebase Admin could not resolve a project ID; audit aborted.')
    }
  }

  if (resolvedProjectId !== REQUIRED_PROJECT_ID
      || projectSources.some(([, value]) => value !== resolvedProjectId)
      || configuredHints.some(([, value]) => value !== resolvedProjectId)) {
    throw new Error('Resolved project ID is not gv-sarees; audit aborted.')
  }
  return resolvedProjectId
}

function hashReference(kind, documentId) {
  return `${kind}_${createHash('sha256')
    .update(`gv-sarees:${kind}:${documentId}`)
    .digest('hex')
    .slice(0, 20)}`
}

function toMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value?.toDate === 'function') return value.toDate().getTime()
  if (value instanceof Date) return value.getTime()
  if (Number.isFinite(value?.seconds ?? value?._seconds)) {
    return (value.seconds ?? value._seconds) * 1000
      + Math.floor((value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6)
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getPaymentAttempts(order) {
  return order.paymentAttempts && typeof order.paymentAttempts === 'object'
    ? order.paymentAttempts
    : {}
}

function getAttemptPaymentStatuses(attempt) {
  const payments = attempt?.payments
  if (!payments || typeof payments !== 'object' || Array.isArray(payments)) return []
  return Object.values(payments).map((payment) => payment?.status)
}

function getEffectiveAttemptStatus(attempt = {}) {
  const paymentStatuses = getAttemptPaymentStatuses(attempt)
  if (attempt.status === 'captured' || paymentStatuses.includes('captured')) return 'captured'
  if (attempt.status === 'authorized' || paymentStatuses.includes('authorized')) return 'authorized'
  if (
    attempt.status === 'failed'
    || (paymentStatuses.length > 0 && paymentStatuses.every((status) => status === 'failed'))
  ) return 'failed'
  return attempt.status || 'pending'
}

function getAggregatePaymentStatus(order, paymentAttempts = getPaymentAttempts(order)) {
  const statuses = Object.values(paymentAttempts).map(getEffectiveAttemptStatus)
  if (order.paymentStatus === 'captured' || statuses.includes('captured')) return 'captured'
  if (statuses.includes('authorized')) return 'authorized'
  if (statuses.length > 0 && statuses.every((status) => status === 'failed')) return 'failed'
  if (statuses.length === 0 && order.paymentStatus === 'authorized') return 'authorized'
  return 'pending'
}

function getAttemptStateIssues(attempt, order) {
  const issues = []
  const rawStatus = attempt?.status
  const paymentStatuses = getAttemptPaymentStatuses(attempt)

  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return ['attempt_record_invalid']
  }
  if (typeof rawStatus !== 'string' || rawStatus.length === 0) {
    issues.push('attempt_status_missing')
  } else if (!KNOWN_ATTEMPT_STATUSES.has(rawStatus)) {
    issues.push('attempt_status_unknown')
  }

  const payments = attempt.payments
  if (payments && typeof payments === 'object' && !Array.isArray(payments)) {
    for (const payment of Object.values(payments)) {
      if (!payment || typeof payment !== 'object' || Array.isArray(payment)
          || typeof payment.status !== 'string') {
        issues.push('payment_status_missing')
      } else if (!KNOWN_PAYMENT_STATUSES.has(payment.status)) {
        issues.push('payment_status_unknown')
      }
    }
  } else if (payments !== undefined && payments !== null) {
    issues.push('payments_record_invalid')
  }

  const childStatusSet = new Set(paymentStatuses)
  if (
    paymentStatuses.length > 0
    && (
      (
        rawStatus === 'captured'
        && !childStatusSet.has('captured')
        && !(childStatusSet.has('refunded') && order.refundStatus === 'processed')
      )
      || (rawStatus === 'authorized' && !childStatusSet.has('authorized'))
      || (rawStatus === 'failed' && !paymentStatuses.every((status) => status === 'failed'))
      || (
        ['pending', 'creating'].includes(rawStatus)
        && (childStatusSet.has('captured') || childStatusSet.has('authorized'))
      )
    )
  ) {
    issues.push('attempt_and_payment_states_inconsistent')
  }
  return [...new Set(issues)]
}

function isReservationHoldingStock(order) {
  if (typeof order.stockReserved === 'boolean') return order.stockReserved
  return order.reservationStatus === 'active'
    && !order.stockDeducted
    && !order.stockRestored
}

function getReservationItems(order) {
  const storedItems = [order.items, order.orderItems, order.products]
    .find((value) => Array.isArray(value) && value.length)
  if (storedItems) {
    return storedItems.map((item) => ({
      productId: item?.productId || item?.id,
      quantity: item?.quantity ?? item?.reservedQuantity,
    }))
  }
  if (!order.productId || !Number.isInteger(order.reservedQuantity)) return []
  return [{ productId: order.productId, quantity: order.reservedQuantity }]
}

function normalizeInventory(data = {}) {
  const totalStock = Math.max(0, Number.isInteger(data.totalStock) ? data.totalStock : 0)
  const reservedStock = Math.max(0, Number.isInteger(data.reservedStock) ? data.reservedStock : 0)
  return {
    totalStock,
    reservedStock: Math.min(reservedStock, totalStock),
  }
}

function newOrderCategorySets() {
  return Object.fromEntries(ORDER_CATEGORIES.map((category) => [category, new Set()]))
}

function newAttemptCategorySets() {
  return Object.fromEntries(ATTEMPT_CATEGORIES.map((category) => [category, new Set()]))
}

function addCategoryReference(categorySets, category, orderId) {
  categorySets[category].add(orderId)
}

function addOrderAnomaly(anomalies, orderId, code) {
  if (!anomalies.has(code)) anomalies.set(code, new Set())
  anomalies.get(code).add(orderId)
}

function isFulfilled(order) {
  return order.reservationStatus === 'converted'
    && order.stockDeducted === true
    && order.orderStatus === 'confirmed'
    && !isReservationHoldingStock(order)
    && order.stockRestored !== true
}

function hasPendingReconciliation(order) {
  return RECONCILIATION_STATUSES.has(order.paymentReconciliationStatus)
}

function isCapturedAndSettled(order, captured, fulfilled) {
  return captured
    && fulfilled
    && !hasPendingReconciliation(order)
    && (order.refundRequired !== true || order.refundStatus === 'processed')
}

function isCapturedResolved(order, captured, capturedSettled) {
  return capturedSettled
    || (captured && order.refundStatus === 'processed' && !hasPendingReconciliation(order))
}

function addReservationAnomalies(order, orderId, nowMillis, anomalies, expectedReservedByProduct) {
  const holdingStock = isReservationHoldingStock(order)
  const expiresAt = toMillis(order.expiresAt)
  const activeAndUnexpired = order.reservationStatus === 'active'
    && !(expiresAt !== null && expiresAt <= nowMillis)

  if (activeAndUnexpired && !holdingStock && !order.stockDeducted && !order.stockRestored) {
    addOrderAnomaly(anomalies, orderId, 'active_reservation_without_held_stock')
  }
  if (holdingStock && ['converted', 'released', 'expired'].includes(order.reservationStatus)) {
    addOrderAnomaly(anomalies, orderId, 'held_stock_on_nonactive_reservation')
  }
  if (holdingStock && order.stockDeducted === true) {
    addOrderAnomaly(anomalies, orderId, 'stock_marked_held_and_deducted')
  }
  if (order.reservationStatus === 'converted'
      && (order.stockDeducted !== true || holdingStock)) {
    addOrderAnomaly(anomalies, orderId, 'converted_reservation_inventory_flags_mismatch')
  }
  if (order.stockDeducted === true && order.reservationStatus !== 'converted') {
    addOrderAnomaly(anomalies, orderId, 'deducted_stock_without_converted_reservation')
  }
  if (order.stockRestored === true && (holdingStock || order.stockDeducted !== true)) {
    addOrderAnomaly(anomalies, orderId, 'restored_stock_flags_mismatch')
  }
  if (typeof order.inventoryOwnershipStatus === 'string') {
    if (order.inventoryOwnershipStatus === 'held' && !holdingStock) {
      addOrderAnomaly(anomalies, orderId, 'held_inventory_owner_without_held_stock')
    }
    if (order.inventoryOwnershipStatus === 'consumed'
        && (order.stockDeducted !== true || order.reservationStatus !== 'converted')) {
      addOrderAnomaly(anomalies, orderId, 'consumed_inventory_owner_without_fulfillment')
    }
    if (['released', 'released_pending_verification'].includes(order.inventoryOwnershipStatus)
        && holdingStock) {
      addOrderAnomaly(anomalies, orderId, 'released_inventory_owner_with_held_stock')
    }
  }

  if (!holdingStock) return true
  const items = getReservationItems(order)
  if (!items.length) {
    addOrderAnomaly(anomalies, orderId, 'held_reservation_items_missing')
    return false
  }

  for (const item of items) {
    if (typeof item.productId !== 'string' || !item.productId
        || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      addOrderAnomaly(anomalies, orderId, 'held_reservation_items_invalid')
      return false
    }
    const updatedQuantity = (expectedReservedByProduct.get(item.productId) || 0) + item.quantity
    if (!Number.isSafeInteger(updatedQuantity)) {
      addOrderAnomaly(anomalies, orderId, 'held_reservation_quantity_overflow')
      return false
    }
    expectedReservedByProduct.set(item.productId, updatedQuantity)
  }
  return true
}

function classifyOrder(order, orderId, nowMillis, state) {
  const attempts = getPaymentAttempts(order)
  const attemptEntries = Object.entries(attempts)
  const hasRazorpayState = order.paymentMethod === 'razorpay' || attemptEntries.length > 0
  const knownOrderPaymentStatus = ['pending', 'authorized', 'captured', 'failed']
    .includes(order.paymentStatus)
  const aggregateStatus = attemptEntries.length > 0
    ? getAggregatePaymentStatus(order, attempts)
    : knownOrderPaymentStatus
      ? order.paymentStatus
      : 'unknown'
  const captured = hasRazorpayState && aggregateStatus === 'captured'
  const fulfilled = isFulfilled(order)
  const capturedSettled = isCapturedAndSettled(order, captured, fulfilled)
  const capturedResolved = isCapturedResolved(order, captured, capturedSettled)
  const capturedAwaiting = captured && !fulfilled && order.refundStatus !== 'processed'
  const capturedReconciliation = captured && (
    hasPendingReconciliation(order)
    || (order.refundRequired === true && order.refundStatus !== 'processed')
  )

  if (capturedSettled) addCategoryReference(state.orderCategories, 'capturedAndFulfilled', orderId)
  if (capturedAwaiting) addCategoryReference(state.orderCategories, 'capturedAwaitingFulfillment', orderId)
  if (capturedReconciliation) {
    addCategoryReference(state.orderCategories, 'capturedRequiringReconciliation', orderId)
  }
  if (order.refundRequired === true) addCategoryReference(state.orderCategories, 'refundRequired', orderId)
  if (order.refundStatus === 'processed') addCategoryReference(state.orderCategories, 'refundProcessed', orderId)
  if (hasRazorpayState && aggregateStatus === 'pending') {
    addCategoryReference(state.orderCategories, 'pendingPayment', orderId)
  }
  if (hasRazorpayState && aggregateStatus === 'authorized') {
    addCategoryReference(state.orderCategories, 'authorizedPayment', orderId)
  }
  if (order.paymentReconciliationStatus === 'manual_review') {
    addCategoryReference(state.orderCategories, 'manualReview', orderId)
  }

  const orderPaymentStateIssue = hasRazorpayState && (
    !knownOrderPaymentStatus
    || (attemptEntries.length > 0 && order.paymentStatus !== aggregateStatus)
  )
  if (orderPaymentStateIssue) {
    const issue = typeof order.paymentStatus !== 'string' || order.paymentStatus.length === 0
      ? 'order_payment_status_missing'
      : !knownOrderPaymentStatus
        ? 'unknown_order_payment_status'
        : 'order_status_differs_from_attempt_aggregate'
    addOrderAnomaly(state.orderPaymentAnomalies, orderId, issue)
  }

  let orderHasUnresolvedAttempt = false
  let orderHasUnknownAttempt = false
  for (const [attemptKey, attempt] of attemptEntries) {
    const effectiveStatus = getEffectiveAttemptStatus(attempt)
    const attemptIssues = getAttemptStateIssues(attempt, order)
    const attemptReference = `${orderId}\u0000${attemptKey}`
    state.totalAttempts += 1
    const paymentStatus = ['creating', 'pending'].includes(effectiveStatus)
      ? 'pending'
      : EFFECTIVE_ATTEMPT_STATUSES.has(effectiveStatus)
        ? effectiveStatus
        : null

    if (paymentStatus) state.attemptCategories[paymentStatus].add(attemptReference)
    if (attemptIssues.length || !paymentStatus) {
      state.attemptCategories.unknownOrInconsistent.add(attemptReference)
      orderHasUnknownAttempt = true
      for (const issue of attemptIssues.length ? attemptIssues : ['attempt_status_unknown']) {
        if (!state.attemptIssueCounts.has(issue)) state.attemptIssueCounts.set(issue, 0)
        state.attemptIssueCounts.set(issue, state.attemptIssueCounts.get(issue) + 1)
      }
    }

    const attemptUnresolved = paymentStatus === 'pending'
      || paymentStatus === 'authorized'
      || !paymentStatus
      || attemptIssues.length > 0
      || (paymentStatus === 'captured' && !capturedResolved)
    if (attemptUnresolved) {
      state.attemptCategories.unresolved.add(attemptReference)
      orderHasUnresolvedAttempt = true
    }
    if (paymentStatus === 'captured' && capturedSettled) {
      state.settledCapturedAttempts.add(attemptReference)
    }
    if (paymentStatus === 'captured' && capturedAwaiting) {
      state.awaitingCapturedAttempts.add(attemptReference)
    }
    if (paymentStatus === 'captured' && capturedReconciliation) {
      state.reconcilingCapturedAttempts.add(attemptReference)
    }
  }

  const orderHasUnresolvedPayment = orderHasUnresolvedAttempt
    || (captured && !capturedResolved)
    || ['pending', 'authorized', 'unknown'].includes(aggregateStatus)
    || (captured && capturedReconciliation)
    || orderPaymentStateIssue
  if (orderHasUnknownAttempt) {
    state.ordersWithUnknownAttempts.add(orderId)
  }
  if (orderHasUnresolvedPayment) {
    addCategoryReference(state.orderCategories, 'unresolvedPayment', orderId)
  }

  const allocationsValid = addReservationAnomalies(
    order,
    orderId,
    nowMillis,
    state.reservationAnomalies,
    state.expectedReservedByProduct,
  )
  if (!allocationsValid) state.reservationAllocationsComplete = false
  if (state.reservationAnomalies.size
      && [...state.reservationAnomalies.values()].some((orderIds) => orderIds.has(orderId))) {
    addCategoryReference(
      state.orderCategories,
      'reservationInventoryInconsistency',
      orderId,
    )
  }
}

function referenceSummary(documentIds, kind = 'order') {
  const references = [...documentIds]
    .map((documentId) => hashReference(kind, documentId))
    .sort()
  return {
    count: references.length,
    hashedReferences: references.slice(0, MAX_HASHED_REFERENCES_PER_CATEGORY),
    truncated: references.length > MAX_HASHED_REFERENCES_PER_CATEGORY,
  }
}

function countSetOverlaps(categorySets, categoryNames, { includeZero = false } = {}) {
  const overlaps = {}
  for (let first = 0; first < categoryNames.length; first += 1) {
    for (let second = first + 1; second < categoryNames.length; second += 1) {
      const firstCategory = categoryNames[first]
      const secondCategory = categoryNames[second]
      let overlapCount = 0
      for (const ref of categorySets[firstCategory]) {
        if (categorySets[secondCategory].has(ref)) overlapCount += 1
      }
      if (includeZero || overlapCount > 0) {
        overlaps[`${firstCategory} ∩ ${secondCategory}`] = overlapCount
      }
    }
  }
  return overlaps
}

function newScanResult() {
  return {
    documentsExamined: 0,
    pagesRead: 0,
    scanComplete: false,
    countIsLowerBound: false,
    limitation: null,
  }
}

function readFailure(error) {
  const code = typeof error?.code === 'string' || typeof error?.code === 'number'
    ? String(error.code)
    : 'unknown'
  return {
    code,
    message: 'Firestore read failed (possibly schema, index, or permission related); this collection scan is incomplete.',
  }
}

function newOrderState() {
  return {
    orderCategories: newOrderCategorySets(),
    attemptCategories: newAttemptCategorySets(),
    reservationAnomalies: new Map(),
    orderPaymentAnomalies: new Map(),
    attemptIssueCounts: new Map(),
    expectedReservedByProduct: new Map(),
    totalAttempts: 0,
    ordersWithUnknownAttempts: new Set(),
    settledCapturedAttempts: new Set(),
    awaitingCapturedAttempts: new Set(),
    reconcilingCapturedAttempts: new Set(),
    reservationAllocationsComplete: true,
  }
}

async function scanOrders(db, nowMillis) {
  const result = newScanResult()
  const state = newOrderState()
  let cursor = null

  while (result.documentsExamined < MAX_DOCUMENTS_PER_COLLECTION) {
    const pageLimit = Math.min(
      PAGE_SIZE,
      MAX_DOCUMENTS_PER_COLLECTION - result.documentsExamined,
    )
    try {
      // Firestore read: construct a projected, bounded page query.
      let query = db.collection('orders').select(...ORDER_FIELDS).limit(pageLimit)
      if (cursor) query = query.startAfter(cursor)

      // Firestore read: fetch this page only.
      const page = await query.get()
      result.pagesRead += 1
      for (const document of page.docs) {
        // Read projected fields from the fetched Firestore snapshot only.
        classifyOrder(document.data(), document.id, nowMillis, state)
      }
      result.documentsExamined += page.size
      if (page.size < pageLimit) {
        result.scanComplete = true
        break
      }
      cursor = page.docs[page.docs.length - 1]
    } catch (error) {
      result.limitation = readFailure(error)
      break
    }
  }

  if (!result.scanComplete && !result.limitation) {
    result.limitation = {
      code: 'DOCUMENT_LIMIT_REACHED',
      message: `Scan stopped at the ${MAX_DOCUMENTS_PER_COLLECTION} document safety limit.`,
    }
  }
  result.countIsLowerBound = !result.scanComplete
  state.reservationAllocationsComplete = state.reservationAllocationsComplete && result.scanComplete
  return { result, state }
}

function inventoryDataIssues(product) {
  const issues = []
  if (!Number.isInteger(product.totalStock) || product.totalStock < 0) {
    issues.push('invalid_total_stock')
  }
  if (!Number.isInteger(product.reservedStock) || product.reservedStock < 0) {
    issues.push('invalid_reserved_stock')
  } else if (Number.isInteger(product.totalStock) && product.reservedStock > product.totalStock) {
    issues.push('reserved_stock_exceeds_total_stock')
  }
  return issues
}

async function scanProducts(db, orderScan) {
  const result = {
    ...newScanResult(),
    productsWithNonZeroReservedStock: 0,
    productsWithInventoryDataIssues: new Map(),
    inventoryComparison: {
      complete: false,
      productsCompared: 0,
      observedMismatches: 0,
      mismatchTypes: {},
      hashedProductReferences: [],
      hashedReferencesTruncated: false,
      limitation: null,
    },
  }
  const productInventory = new Map()
  let cursor = null

  while (result.documentsExamined < MAX_DOCUMENTS_PER_COLLECTION) {
    const pageLimit = Math.min(
      PAGE_SIZE,
      MAX_DOCUMENTS_PER_COLLECTION - result.documentsExamined,
    )
    try {
      // Firestore read: construct a projected, bounded page query.
      let query = db.collection('products').select(...PRODUCT_FIELDS).limit(pageLimit)
      if (cursor) query = query.startAfter(cursor)

      // Firestore read: fetch this page only.
      const page = await query.get()
      result.pagesRead += 1
      for (const document of page.docs) {
        // Read projected fields from the fetched Firestore snapshot only.
        const product = document.data()
        const normalized = normalizeInventory(product)
        productInventory.set(document.id, normalized.reservedStock)
        if (Number.isInteger(product.reservedStock) && product.reservedStock !== 0) {
          result.productsWithNonZeroReservedStock += 1
        }
        const issues = inventoryDataIssues(product)
        if (issues.length) result.productsWithInventoryDataIssues.set(document.id, issues)
      }
      result.documentsExamined += page.size
      if (page.size < pageLimit) {
        result.scanComplete = true
        break
      }
      cursor = page.docs[page.docs.length - 1]
    } catch (error) {
      result.limitation = readFailure(error)
      break
    }
  }

  if (!result.scanComplete && !result.limitation) {
    result.limitation = {
      code: 'DOCUMENT_LIMIT_REACHED',
      message: `Scan stopped at the ${MAX_DOCUMENTS_PER_COLLECTION} document safety limit.`,
    }
  }
  result.countIsLowerBound = !result.scanComplete

  const inventoryComparisonComplete = result.scanComplete
    && orderScan.result.scanComplete
    && orderScan.state.reservationAllocationsComplete
  const mismatchProducts = new Map()
  const mismatchTypes = new Map()
  let productsCompared = 0
  let missingProductDocuments = 0

  if (inventoryComparisonComplete) {
    const productIds = new Set([
      ...productInventory.keys(),
      ...orderScan.state.expectedReservedByProduct.keys(),
    ])
    for (const productId of productIds) {
      const expected = orderScan.state.expectedReservedByProduct.get(productId) || 0
      const actual = productInventory.get(productId)
      if (actual === undefined) {
        missingProductDocuments += 1
        mismatchProducts.set(productId, true)
        mismatchTypes.set('held_order_references_missing_product', (mismatchTypes.get('held_order_references_missing_product') || 0) + 1)
        continue
      }
      productsCompared += 1
      if (expected !== actual) {
        mismatchProducts.set(productId, true)
        const type = expected > actual
          ? 'held_order_quantity_exceeds_product_reserved_stock'
          : 'product_reserved_stock_exceeds_held_order_quantity'
        mismatchTypes.set(type, (mismatchTypes.get(type) || 0) + 1)
      }
    }
  }

  const mismatchReferences = [...mismatchProducts.keys()]
    .map((productId) => hashReference('product', productId))
    .sort()
  result.inventoryComparison = {
    complete: inventoryComparisonComplete,
    productsCompared,
    observedMismatches: mismatchProducts.size,
    missingProductDocuments,
    mismatchTypes: Object.fromEntries(mismatchTypes),
    hashedProductReferences: mismatchReferences.slice(0, MAX_HASHED_REFERENCES_PER_CATEGORY),
    hashedReferencesTruncated: mismatchReferences.length > MAX_HASHED_REFERENCES_PER_CATEGORY,
    limitation: inventoryComparisonComplete
      ? null
      : 'Comparison is incomplete because a collection scan was incomplete or a held reservation had missing/invalid item allocations.',
  }
  return result
}

function categoryReport(categorySets, names) {
  return Object.fromEntries(names.map((name) => [name, referenceSummary(categorySets[name])]))
}

function attemptCategoryReport(state) {
  const categories = {}
  for (const name of ATTEMPT_CATEGORIES) {
    const attemptReferences = state.attemptCategories[name]
    const orderIds = new Set([...attemptReferences].map((reference) => reference.split('\u0000', 1)[0]))
    categories[name] = {
      attemptCount: attemptReferences.size,
      uniqueOrderCount: orderIds.size,
      hashedOrderReferences: referenceSummary(orderIds).hashedReferences,
      hashedOrderReferencesTruncated: orderIds.size > MAX_HASHED_REFERENCES_PER_CATEGORY,
    }
  }
  const allAttemptReferences = new Set(
    ATTEMPT_CATEGORIES.flatMap((name) => [...state.attemptCategories[name]]),
  )
  const allAttemptOrders = new Set(
    [...allAttemptReferences].map((reference) => reference.split('\u0000', 1)[0]),
  )
  categories.total = {
    attemptCount: state.totalAttempts,
    uniqueOrderCount: allAttemptOrders.size,
    hashedOrderReferences: referenceSummary(allAttemptOrders).hashedReferences,
    hashedOrderReferencesTruncated: allAttemptOrders.size > MAX_HASHED_REFERENCES_PER_CATEGORY,
  }
  categories.capturedAndFulfilled = {
    attemptCount: state.settledCapturedAttempts.size,
  }
  categories.capturedAwaitingFulfillment = {
    attemptCount: state.awaitingCapturedAttempts.size,
  }
  categories.capturedRequiringReconciliation = {
    attemptCount: state.reconcilingCapturedAttempts.size,
  }
  return categories
}

function formatAnomalies(anomalies) {
  return Object.fromEntries([...anomalies.entries()].map(([code, orderIds]) => [
    code,
    referenceSummary(orderIds),
  ]))
}

function formatOrderReport(scan, state, products) {
  const orderCategories = categoryReport(state.orderCategories, ORDER_CATEGORIES)
  const orderOverlaps = countSetOverlaps(
    state.orderCategories,
    ORDER_CATEGORIES,
  )
  const attemptOverlaps = countSetOverlaps(
    state.attemptCategories,
    ATTEMPT_CATEGORIES,
  )
  const reservationAnomalies = formatAnomalies(state.reservationAnomalies)
  const productInventoryIssues = Object.fromEntries(
    [...products.productsWithInventoryDataIssues.entries()].map(([productId, issues]) => [
      hashReference('product', productId),
      issues,
    ]).slice(0, MAX_HASHED_REFERENCES_PER_CATEGORY),
  )

  return {
    ...scan,
    uniqueOrdersByCategory: orderCategories,
    orderCategoryOverlaps: orderOverlaps,
    orderCategoryOverlapsComplete: scan.scanComplete,
    paymentAttempts: {
      ...attemptCategoryReport(state),
      stateIssueCounts: Object.fromEntries(state.attemptIssueCounts),
      orderStateInconsistencies: formatAnomalies(state.orderPaymentAnomalies),
      ordersWithUnknownOrInconsistentAttempts: referenceSummary(state.ordersWithUnknownAttempts),
      categoryOverlaps: attemptOverlaps,
      categoryOverlapsComplete: scan.scanComplete,
    },
    reservationInventoryInconsistencies: {
      uniqueOrderCount: new Set(
        [...state.reservationAnomalies.values()].flatMap((ids) => [...ids]),
      ).size,
      byType: reservationAnomalies,
      productInventoryDataIssueCount: products.productsWithInventoryDataIssues.size,
      hashedProductInventoryDataIssues: productInventoryIssues,
      productInventoryDataIssueReferencesTruncated:
        products.productsWithInventoryDataIssues.size > MAX_HASHED_REFERENCES_PER_CATEGORY,
      productStockComparison: products.inventoryComparison,
    },
  }
}

async function main() {
  // Match the existing production reservation audit guard exactly.
  assertNoEmulatorConfiguration()
  await import('../server/firebaseAdmin.js')
  assertNoEmulatorConfiguration()

  const app = getApps().find((candidate) => candidate.name === '[DEFAULT]')
  if (!app) throw new Error('The existing Firebase Admin default app was not initialized.')
  const projectId = await verifyProjectId(app)

  // Firestore client acquisition occurs only after the project identity is verified.
  const { getFirestore } = await import('firebase-admin/firestore')
  const db = getFirestore(app)
  const nowMillis = Date.now()
  const orderScan = await scanOrders(db, nowMillis)
  const products = await scanProducts(db, orderScan)
  const report = {
    audit: 'READ-ONLY — NO FIRESTORE WRITES',
    projectId,
    generatedAtUtc: new Date(nowMillis).toISOString(),
    pagination: {
      pageSize: PAGE_SIZE,
      maximumDocumentsPerCollection: MAX_DOCUMENTS_PER_COLLECTION,
      maximumHashedReferencesPerCategory: MAX_HASHED_REFERENCES_PER_CATEGORY,
    },
    classificationNotes: {
      capturedAndFulfilled: 'Captured payment plus converted reservation, confirmed order, deducted stock, no held reservation, and no outstanding reconciliation/refund requirement.',
      capturedAwaitingFulfillment: 'Captured payment without completed fulfillment markers, except when refundStatus is processed.',
      capturedRequiringReconciliation: 'Captured payment with pending/manual_review reconciliation or an unprocessed required refund.',
      unresolvedPayment: 'Pending, authorized, unknown/inconsistent, or captured-but-not-settled state. Captured-and-fulfilled settled orders are excluded.',
      attemptStatus: 'Uses the payment service effective-status precedence: captured, authorized, all-failed, then stored status/default pending; creating is reported as pending.',
      inventory: 'Held stock follows inventory.hasReservationStock semantics. Product reservedStock is compared with quantities from held order item snapshots using normalizeInventory semantics.',
      overlaps: 'Order categories may overlap. Attempt status categories may overlap with unknown/inconsistent and unresolved categories.',
      consistency: 'Collection scans are bounded reads, not a transactional point-in-time snapshot.',
    },
    orders: formatOrderReport(orderScan.result, orderScan.state, products),
    products: {
      documentsExamined: products.documentsExamined,
      pagesRead: products.pagesRead,
      scanComplete: products.scanComplete,
      countIsLowerBound: products.countIsLowerBound,
      productsWithNonZeroReservedStock: products.productsWithNonZeroReservedStock,
      productsWithInventoryDataIssues: products.productsWithInventoryDataIssues.size,
      limitation: products.limitation,
    },
  }

  console.log(JSON.stringify(report, null, 2))
  if (!orderScan.result.scanComplete || !products.scanComplete) process.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown audit error.'
  console.error(`Production payment-exception audit aborted: ${message}`)
  process.exitCode = 1
})
