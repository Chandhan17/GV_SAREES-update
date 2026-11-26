/**
 * READ-ONLY — NO FIRESTORE WRITES
 *
 * This audit uses the application's existing Firebase Admin initialization.
 * It performs bounded Firestore reads only; it does not call payment,
 * messaging, or other mutation APIs.
 */
import process from 'node:process'
import { getApps } from 'firebase-admin/app'

const REQUIRED_PROJECT_ID = 'gv-sarees'
const PAGE_SIZE = 250
const MAX_DOCUMENTS_PER_COLLECTION = 100000
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
  'paymentMethod',
  'paymentStatus',
  'paymentReconciliationStatus',
  'refundRequired',
  'refundStatus',
  'orderStatus',
  'paymentAttempts',
]
const ORDER_CATEGORIES = [
  'activeReservations',
  'expiredReservationsWithReservedStock',
  'pendingRazorpayPayments',
  'authorizedRazorpayPayments',
  'capturedPaymentsAwaitingFulfillmentOrReconciliation',
  'refundRequired',
  'manualReview',
  'unresolvedPaymentAttempts',
  'ordersWithReservedStockStillHeld',
]

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

function hasReservationStock(order) {
  if (typeof order.stockReserved === 'boolean') return order.stockReserved
  return order.reservationStatus === 'active'
    && !order.stockDeducted
    && !order.stockRestored
}

function hasCapturedPayment(order) {
  return order.paymentStatus === 'captured'
    || Object.values(order.paymentAttempts || {}).some((attempt) => (
      attempt?.status === 'captured'
      || Object.values(attempt?.payments || {}).some((payment) => payment?.status === 'captured')
    ))
}

function hasUnsettledRazorpayPayment(order) {
  if (order.paymentMethod !== 'razorpay') return false
  if (order.paymentStatus === 'captured' && order.refundStatus === 'processed') return false
  const attempts = Object.values(order.paymentAttempts || {})
  if (['captured', 'authorized'].includes(order.paymentStatus) || attempts.some((attempt) => (
    attempt?.status === 'captured'
    || Object.values(attempt?.payments || {}).some((payment) => payment?.status === 'captured')
  ))) return true
  if (!attempts.length) return ['pending', 'authorized'].includes(order.paymentStatus)
  return attempts.some((attempt) => {
    const statuses = Object.values(attempt?.payments || {}).map((payment) => payment?.status)
    if (attempt?.status === 'authorized' || statuses.includes('authorized')) return true
    if (attempt?.status === 'failed' && statuses.every((status) => status === 'failed')) return false
    return attempt?.status !== 'failed' || statuses.some((status) => status !== 'failed')
  })
}

function newOrderCategorySets() {
  return Object.fromEntries(ORDER_CATEGORIES.map((category) => [category, new Set()]))
}

function addOrderToCategories(document, categories, nowMillis) {
  // Read fields from the projected Firestore snapshot already fetched above.
  const order = document.data()
  const id = document.id
  const expiresAt = toMillis(order.expiresAt)
  const reservedStock = hasReservationStock(order)
  const razorpay = order.paymentMethod === 'razorpay'
  const captured = razorpay && hasCapturedPayment(order)

  if (order.reservationStatus === 'active' && !(expiresAt !== null && expiresAt <= nowMillis)) {
    categories.activeReservations.add(id)
  }
  if ((order.reservationStatus === 'expired' || (expiresAt !== null && expiresAt <= nowMillis))
      && reservedStock) {
    categories.expiredReservationsWithReservedStock.add(id)
  }
  if (razorpay && order.paymentStatus === 'pending') {
    categories.pendingRazorpayPayments.add(id)
  }
  if (razorpay && order.paymentStatus === 'authorized') {
    categories.authorizedRazorpayPayments.add(id)
  }
  if (captured && (
    order.orderStatus !== 'confirmed'
    || order.reservationStatus !== 'converted'
    || order.stockDeducted !== true
    || order.refundRequired === true
    || ['pending', 'manual_review'].includes(order.paymentReconciliationStatus)
  )) {
    categories.capturedPaymentsAwaitingFulfillmentOrReconciliation.add(id)
  }
  if (order.refundRequired === true) categories.refundRequired.add(id)
  if (order.paymentReconciliationStatus === 'manual_review') categories.manualReview.add(id)
  if (hasUnsettledRazorpayPayment(order)) categories.unresolvedPaymentAttempts.add(id)
  if (reservedStock) categories.ordersWithReservedStockStillHeld.add(id)
}

function countOverlaps(categories) {
  const overlaps = {}
  for (let first = 0; first < ORDER_CATEGORIES.length; first += 1) {
    for (let second = first + 1; second < ORDER_CATEGORIES.length; second += 1) {
      const firstCategory = ORDER_CATEGORIES[first]
      const secondCategory = ORDER_CATEGORIES[second]
      let overlapCount = 0
      for (const id of categories[firstCategory]) {
        if (categories[secondCategory].has(id)) overlapCount += 1
      }
      overlaps[`${firstCategory} ∩ ${secondCategory}`] = overlapCount
    }
  }
  return overlaps
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

async function scanOrders(db, nowMillis) {
  const categories = newOrderCategorySets()
  const result = {
    documentsExamined: 0,
    pagesRead: 0,
    scanComplete: false,
    countIsLowerBound: false,
    categories: {},
    pairwiseOverlaps: {},
    pairwiseOverlapsComplete: false,
    limitation: null,
  }
  let cursor = null

  while (result.documentsExamined < MAX_DOCUMENTS_PER_COLLECTION) {
    const pageLimit = Math.min(
      PAGE_SIZE,
      MAX_DOCUMENTS_PER_COLLECTION - result.documentsExamined,
    )
    try {
      // Firestore read: construct a projected, bounded page query; no write API is used.
      let query = db.collection('orders').select(...ORDER_FIELDS).limit(pageLimit)
      if (cursor) query = query.startAfter(cursor)

      // Firestore read: fetch this page only.
      const page = await query.get()
      result.pagesRead += 1
      for (const document of page.docs) {
        addOrderToCategories(document, categories, nowMillis)
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
  result.categories = Object.fromEntries(ORDER_CATEGORIES.map((category) => [
    category,
    { count: categories[category].size, complete: result.scanComplete },
  ]))
  result.pairwiseOverlaps = countOverlaps(categories)
  result.pairwiseOverlapsComplete = result.scanComplete
  return result
}

async function scanProducts(db) {
  const result = {
    documentsExamined: 0,
    pagesRead: 0,
    scanComplete: false,
    productsWithNonZeroReservedStock: 0,
    productsWithMissingOrInvalidReservedStock: 0,
    countIsLowerBound: false,
    limitation: null,
  }
  let cursor = null

  while (result.documentsExamined < MAX_DOCUMENTS_PER_COLLECTION) {
    const pageLimit = Math.min(
      PAGE_SIZE,
      MAX_DOCUMENTS_PER_COLLECTION - result.documentsExamined,
    )
    try {
      // Firestore read: construct a projected, bounded page query; no write API is used.
      let query = db.collection('products').select('reservedStock').limit(pageLimit)
      if (cursor) query = query.startAfter(cursor)

      // Firestore read: fetch this page only.
      const page = await query.get()
      result.pagesRead += 1
      for (const document of page.docs) {
        // Read a field from the in-memory Firestore snapshot, not from the service.
        const reservedStock = document.get('reservedStock')
        if (!Number.isInteger(reservedStock)) {
          result.productsWithMissingOrInvalidReservedStock += 1
        } else if (reservedStock !== 0) {
          result.productsWithNonZeroReservedStock += 1
        }
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
  return result
}

async function main() {
  // Check before loading the application's configuration, then again afterward
  // because that module may load .env.local.
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
  const orders = await scanOrders(db, nowMillis)
  const products = await scanProducts(db)
  const report = {
    audit: 'READ-ONLY — NO FIRESTORE WRITES',
    projectId,
    generatedAtUtc: new Date(nowMillis).toISOString(),
    pagination: {
      pageSize: PAGE_SIZE,
      maximumDocumentsPerCollection: MAX_DOCUMENTS_PER_COLLECTION,
    },
    orders,
    products,
    overlapNote: 'Order categories are non-exclusive; pairwise overlaps are reported. Product counts are from a separate collection.',
  }

  console.log(JSON.stringify(report, null, 2))
  if (!orders.scanComplete || !products.scanComplete) process.exitCode = 1
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown audit error.'
  console.error(`Production reservation audit aborted: ${message}`)
  process.exitCode = 1
})
