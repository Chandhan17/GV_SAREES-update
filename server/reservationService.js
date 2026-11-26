import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import process from 'node:process'
import { getFirestore } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'
import { adjustInventory, convertInventory, hasReservationStock, normalizeInventory, releaseInventory, reserveInventory } from './inventory.js'
import { cancellationTokenMatches, hashCancellationToken, isReservationExpired, makeCancellationToken, normalizeCustomer, reservationFingerprint } from './reservationSecurity.js'

const db = getFirestore()
const DEFAULT_CHECKOUT_HOLD_MINUTES = 30
const CLEANUP_PAGE_SIZE = 50
const FIRESTORE_DIAGNOSTIC_INTERVAL_MS = 10_000

const FIRESTORE_STAGES = Object.freeze({
  reservationIdempotencyRead: 'reservation_idempotency_read',
  reservationExistingOrderRead: 'reservation_existing_order_read',
  reservationExistingProductRead: 'reservation_existing_product_read',
  reservationProductRead: 'reservation_product_read',
  reservationTransaction: 'reservation_transaction',
  statusTokenRead: 'reservation_status_token_read',
  statusOrdersQuery: 'reservation_status_orders_query',
})

async function withFirestoreDiagnostics(stage, operation) {
  const startedAt = Date.now()
  const log = (outcome) => {
    console.info(`[reservation-firestore] stage=${stage} outcome=${outcome} elapsed_ms=${Date.now() - startedAt}`)
  }
  log('start')
  const intervalId = setInterval(() => log('pending'), FIRESTORE_DIAGNOSTIC_INTERVAL_MS)

  try {
    const result = await operation()
    log('success')
    return result
  } catch (error) {
    log('failure')
    throw error
  } finally {
    clearInterval(intervalId)
  }
}

function productRef(productId, firestore = db) {
  return firestore.collection('products').doc(productId)
}

function orderRef(orderId, firestore = db) {
  return firestore.collection('orders').doc(orderId)
}

function historyRef(firestore = db) {
  return firestore.collection('inventoryHistory').doc()
}

export function getReservationItems(order = {}) {
  const storedItems = [order.items, order.orderItems, order.products]
    .find((value) => Array.isArray(value) && value.length)
  if (storedItems) {
    return storedItems.map((item) => ({
      productId: item.productId || item.id,
      productName: item.productName || item.name || '',
      image: item.image || '',
      selectedSize: item.selectedSize || item.sizeLength || '',
      quantity: item.quantity ?? item.reservedQuantity,
      price: item.price ?? item.unitPrice,
    }))
  }
  if (!order.productId || !Number.isInteger(order.reservedQuantity)) return []
  return [{
    productId: order.productId,
    productName: order.productName || '',
    image: order.image || '',
    selectedSize: order.selectedSize || '',
    quantity: order.reservedQuantity,
    price: order.price,
  }]
}

function getProductQuantities(items) {
  const quantities = new Map()
  for (const item of items) {
    quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity)
  }
  return quantities
}

async function getProductSnapshots(transaction, productIds, firestore) {
  const snapshots = await Promise.all([...productIds].map(async (productId) => (
    [productId, await transaction.get(productRef(productId, firestore))]
  )))
  return new Map(snapshots)
}

export async function releaseReservationStockInTransaction(transaction, reservationRef, order, {
  firestore = db,
  timestamp = Timestamp,
  releasedAt,
  reason = 'Reservation released',
  actionType = 'release',
  adminUid,
  productSnapshot,
  productSnapshots: suppliedSnapshots,
  inventoryState: suppliedInventoryState,
} = {}) {
  if (!hasReservationStock(order)) {
    return {
      orderPatch: { stockReserved: false, inventoryOwnershipStatus: 'released' },
      inventory: null,
    }
  }

  const quantities = getProductQuantities(getReservationItems(order))
  const productSnapshots = suppliedSnapshots
    || (productSnapshot && quantities.size === 1
      ? new Map([[quantities.keys().next().value, productSnapshot]])
      : await getProductSnapshots(transaction, quantities.keys(), firestore))
  const inventoryState = suppliedInventoryState || new Map()
  for (const productId of quantities.keys()) {
    if (!productSnapshots.get(productId)?.exists) {
      throw Object.assign(new Error('Product no longer exists.'), { code: 'PRODUCT_NOT_FOUND' })
    }
  }

  const stockReleasedAt = releasedAt || timestamp.now()
  const updates = new Map()
  for (const [productId, quantity] of quantities) {
    const snapshot = productSnapshots.get(productId)
    const product = inventoryState.get(productId) || snapshot.data()
    updates.set(productId, {
      snapshot,
      previous: product,
      inventory: releaseInventory(product, quantity),
    })
  }
  for (const [productId, result] of updates) {
    inventoryState.set(productId, result.inventory)
    transaction.update(result.snapshot.ref, result.inventory)
    transaction.set(historyRef(firestore), {
      productId,
      actionType,
      quantityChanged: -quantities.get(productId),
      previousQuantity: normalizeInventory(result.previous).reservedStock,
      newQuantity: normalizeInventory(result.inventory).reservedStock,
      reason,
      reservationId: order.reservationId,
      orderId: reservationRef.id,
      ...(adminUid ? { adminUid } : {}),
      timestamp: stockReleasedAt,
    })
  }

  return {
    orderPatch: {
      stockReserved: false,
      stockReleasedAt,
      inventoryOwnershipStatus: 'released',
    },
    inventory: updates.values().next().value?.inventory || null,
    inventories: inventoryState,
  }
}

export async function reacquireReservationStockForCapturedPayment(transaction, reservationRef, order, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
} = {}) {
  if (order.stockDeducted === true && order.orderStatus === 'confirmed') {
    return { acquired: true, orderPatch: {} }
  }
  if (hasReservationStock(order)) return { acquired: true, orderPatch: {} }
  if (
    !(order.reservationStatus === 'active' && !isExpired(order, now()))
      && !(order.checkoutAbandoned === true && order.reservationStatus === 'released')
    || order.stockRestored === true
    || order.orderStatus === 'cancelled'
    || order.orderStatus === 'completed'
  ) {
    return { acquired: false, reason: 'reservation_not_available' }
  }

  const quantities = getProductQuantities(getReservationItems(order))
  const productSnapshots = await getProductSnapshots(transaction, quantities.keys(), firestore)
  if ([...productSnapshots.values()].some((snapshot) => !snapshot.exists)) {
    return { acquired: false, reason: 'product_unavailable' }
  }

  const updates = new Map()
  try {
    for (const [productId, quantity] of quantities) {
      const product = productSnapshots.get(productId).data()
      updates.set(productId, {
        product,
        inventory: reserveInventory(product, quantity),
      })
    }
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return { acquired: false, reason: 'insufficient_stock' }
    }
    throw error
  }

  const reacquiredAt = timestamp.now()
  for (const [productId, result] of updates) {
    const snapshot = productSnapshots.get(productId)
    transaction.update(snapshot.ref, result.inventory)
    transaction.set(historyRef(firestore), {
      productId,
      actionType: 'reserve',
      quantityChanged: quantities.get(productId),
      previousQuantity: normalizeInventory(result.product).reservedStock,
      newQuantity: normalizeInventory(result.inventory).reservedStock,
      reason: 'Inventory reacquired for captured Razorpay payment',
      reservationId: order.reservationId,
      orderId: reservationRef.id,
      timestamp: reacquiredAt,
    })
  }

  return {
    acquired: true,
    orderPatch: {
      stockReserved: true,
      stockReleasedAt: null,
      stockReacquiredAt: reacquiredAt,
      inventoryOwnershipStatus: 'held',
    },
  }
}

export async function fulfillCapturedReservationInTransaction(transaction, reservationRef, order, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  adminUid,
} = {}) {
  if (order.stockDeducted === true && order.reservationStatus === 'converted' && order.orderStatus === 'confirmed') {
    return { fulfilled: true, alreadyFulfilled: true, orderPatch: {} }
  }
  if (order.refundRequired === true || order.paymentReconciliationStatus === 'manual_review') {
    return { fulfilled: false, reason: 'refund_required' }
  }
  const activeReservation = order.reservationStatus === 'active'
    && (!isExpired(order, now()) || hasReservationStock(order))
  const abandonedCheckout = order.checkoutAbandoned === true
    && ['released', 'expired'].includes(order.reservationStatus)
  if (
    (!activeReservation && !abandonedCheckout)
    || order.stockRestored === true
    || order.orderStatus === 'cancelled'
    || order.orderStatus === 'completed'
  ) {
    return { fulfilled: false, reason: 'reservation_not_available' }
  }
  const quantities = getProductQuantities(getReservationItems(order))
  const productSnapshots = await getProductSnapshots(transaction, quantities.keys(), firestore)
  if ([...productSnapshots.values()].some((snapshot) => !snapshot.exists)) {
    return { fulfilled: false, reason: 'product_unavailable' }
  }

  const updates = new Map()
  try {
    for (const [productId, quantity] of quantities) {
      const product = productSnapshots.get(productId).data()
      const heldInventory = hasReservationStock(order)
        ? convertInventory(product, quantity)
        : convertInventory(reserveInventory(product, quantity), quantity)
      updates.set(productId, { product, inventory: heldInventory })
    }
  } catch (error) {
    if (['INSUFFICIENT_STOCK', 'RESERVATION_MISMATCH'].includes(error?.code)) {
      return { fulfilled: false, reason: 'insufficient_stock' }
    }
    throw error
  }

  const fulfilledAt = timestamp.now()
  for (const [productId, result] of updates) {
    const snapshot = productSnapshots.get(productId)
    transaction.update(snapshot.ref, result.inventory)
    transaction.set(historyRef(firestore), {
      productId,
      actionType: 'convert',
      quantityChanged: -quantities.get(productId),
      previousQuantity: normalizeInventory(result.product).totalStock,
      newQuantity: result.inventory.totalStock,
      reason: 'Captured Razorpay payment automatically confirmed',
      reservationId: order.reservationId,
      orderId: reservationRef.id,
      ...(adminUid ? { adminUid } : {}),
      timestamp: fulfilledAt,
    })
  }
  return {
    fulfilled: true,
    alreadyFulfilled: false,
    orderPatch: {
      paymentMethod: 'razorpay',
      paymentStatus: 'captured',
      reservationStatus: 'converted',
      convertedAt: fulfilledAt,
      stockReserved: false,
      stockReleasedAt: null,
      stockDeducted: true,
      inventoryOwnershipStatus: 'consumed',
      paymentReconciliationStatus: null,
      paymentReconciliationReason: null,
      refundRequired: false,
      orderStatus: 'confirmed',
    },
  }
}

function isExpired(order, now = Date.now()) {
  return isReservationExpired(order.expiresAt, now)
}

function getOrderCreatedAtIso(value) {
  if (value === null || value === undefined) return null
  const timestampDate = value?.toDate?.()
  const date = timestampDate instanceof Date
    ? timestampDate
    : value instanceof Date
      ? value
      : Number.isFinite(value?.seconds ?? value?._seconds)
        ? new Date(((value.seconds ?? value._seconds) * 1000) + Math.floor((value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6))
        : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function isReservationEligibleForPayment(order, now = Date.now()) {
  const active = order.reservationStatus === 'active' && !isExpired(order, now)
  const confirmed = order.reservationStatus === 'converted'
    && order.stockDeducted === true
    && order.orderStatus === 'confirmed'
  return (active || confirmed)
    && !order.stockRestored
    && order.orderStatus !== 'cancelled'
    && order.orderStatus !== 'completed'
}

function isRetryableExpiredRazorpayReservation(order, now = Date.now()) {
  const reservationExpired = ['expired', 'released'].includes(order.reservationStatus)
    || (order.reservationStatus === 'active' && isExpired(order, now))
  if (
    !reservationExpired
    || order.paymentMethod !== 'razorpay'
    || order.stockDeducted === true
    || order.stockRestored === true
    || ['cancelled', 'completed'].includes(order.orderStatus)
    || ['captured', 'paid', 'authorized'].includes(order.paymentStatus)
  ) return false

  const attempts = Object.values(order.paymentAttempts || {})
  const attemptStatuses = attempts.flatMap((attempt) => [
    attempt?.status,
    ...Object.values(attempt?.payments || {}).map((payment) => payment?.status),
  ])
  if (attemptStatuses.some((status) => ['captured', 'authorized'].includes(status))) return false

  return order.checkoutAbandoned === true
    || (order.reservationStatus === 'expired' && order.paymentStatus === 'failed')
    || (order.reservationStatus === 'active' && order.paymentStatus === 'failed')
    || (order.reservationStatus === 'active' && attempts.length === 0)
}

function nextReservationRequestKey(idempotencyKey, reservationId) {
  return createHash('sha256')
    .update(`reservation-generation\0${idempotencyKey}\0${reservationId}`)
    .digest('hex')
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

function isCapturedRazorpayPayment(order) {
  return order.paymentMethod === 'razorpay'
    && (order.paymentStatus === 'captured'
      || Object.values(order.paymentAttempts || {}).some((attempt) => (
        attempt?.status === 'captured'
        || Object.values(attempt?.payments || {}).some((payment) => payment?.status === 'captured')
      )))
}

async function reconcileReservationPayment(order, {
  firestore = db,
  timestamp = Timestamp,
  reconcilePayment,
} = {}) {
  if (order.paymentMethod !== 'razorpay') {
    return { status: 'not_applicable', reconciled: false }
  }
  const reconcile = reconcilePayment
    || (await import('./razorpayPaymentService.js')).reconcileRazorpayReservationPayment
  return reconcile(order.reservationId, { firestore, timestamp })
}

function assertReservationPaymentResolved(result) {
  if (result.status === 'captured') {
    throw Object.assign(
      new Error('A Razorpay payment was captured. Reserved stock was kept; resolve or refund the payment before release.'),
      { code: 'PAYMENT_CAPTURED' },
    )
  }
  if (result.status !== 'failed' && result.status !== 'not_applicable') {
    throw Object.assign(
      new Error('Payment status is still being verified. Reserved stock was kept; try again after reconciliation.'),
      { code: 'PAYMENT_IN_PROGRESS' },
    )
  }
}

function reservationResponse(order, products) {
  const items = getReservationItems(order).map((item) => ({
    ...item,
    lineSubtotal: Number(item.price || 0) * item.quantity,
    availableStock: normalizeInventory(products.get(item.productId) || {}).availableStock,
  }))
  const firstItem = items[0] || {}
  return {
    reservationId: order.reservationId,
    orderId: order.id,
    reservationStatus: order.reservationStatus,
    reservedQuantity: order.reservedQuantity ?? firstItem.quantity,
    expiresAt: order.expiresAt?.toDate?.().toISOString() || order.expiresAt?.toISOString?.() || null,
    availableStock: firstItem.availableStock ?? 0,
    productName: order.productName || firstItem.productName,
    price: order.price ?? firstItem.price,
    totalAmount: order.totalAmount ?? items.reduce((total, item) => total + item.lineSubtotal, 0),
    items,
    cancellationToken: order.cancellationToken,
  }
}

export async function createCheckoutReservation({
  items: submittedItems,
  productId,
  quantity,
  customer,
  selectedSize,
  idempotencyKey,
  expiryMinutes = DEFAULT_CHECKOUT_HOLD_MINUTES,
}, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  cancellationSecret = process.env.RESERVATION_TOKEN_SECRET,
} = {}) {
  const reservationItems = submittedItems || [{ productId, quantity, selectedSize }]
  if (!reservationItems.length || reservationItems.some((item) => (
    typeof item.productId !== 'string'
    || !item.productId.trim()
    || !Number.isInteger(item.quantity)
    || item.quantity <= 0
  ))) {
    throw Object.assign(new Error('Reservation items are invalid.'), { code: 'INVALID_QUANTITY' })
  }
  const normalizedItems = reservationItems.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    selectedSize: String(item.selectedSize || '').trim(),
  }))
  const fingerprint = submittedItems
    ? reservationFingerprint({ items: normalizedItems, customer })
    : reservationFingerprint({ productId, quantity, selectedSize, customer })
  if (!cancellationSecret || Buffer.byteLength(cancellationSecret) < 32) {
    throw new Error('Reservation cancellation is not configured.')
  }
  const requestRef = firestore.collection('reservationRequests').doc(idempotencyKey)
  const newOrderRef = firestore.collection('orders').doc()
  const expiresAt = timestamp.fromMillis(now() + expiryMinutes * 60 * 1000)

  const runReservationTransaction = () => firestore.runTransaction(async (transaction) => {
    const rootRequestSnapshot = await withFirestoreDiagnostics(
      FIRESTORE_STAGES.reservationIdempotencyRead,
      () => transaction.get(requestRef),
    )
    let rootRequest = rootRequestSnapshot.exists ? rootRequestSnapshot.data() : null
    if (rootRequest && rootRequest.fingerprint !== fingerprint) {
      throw Object.assign(new Error('This idempotency key was already used for a different request.'), { code: 'IDEMPOTENCY_CONFLICT' })
    }

    let currentRequestKey = rootRequest?.latestRequestKey || idempotencyKey
    let currentRequestRef = currentRequestKey === idempotencyKey
      ? requestRef
      : firestore.collection('reservationRequests').doc(currentRequestKey)
    let currentRequestSnapshot = currentRequestRef === requestRef
      ? rootRequestSnapshot
      : await withFirestoreDiagnostics(
        FIRESTORE_STAGES.reservationIdempotencyRead,
        () => transaction.get(currentRequestRef),
      )
    let requestKeyToCreate = null
    let requestRefToCreate = null
    let parentRequestRef = null
    let reusableOrder = null
    const terminalOrders = []

    while (currentRequestSnapshot.exists) {
      const currentRequest = currentRequestSnapshot.data()
      if (currentRequest.fingerprint !== fingerprint) {
        throw Object.assign(new Error('This idempotency key was already used for a different request.'), { code: 'IDEMPOTENCY_CONFLICT' })
      }
      const existingOrderSnapshot = await withFirestoreDiagnostics(
        FIRESTORE_STAGES.reservationExistingOrderRead,
        () => transaction.get(orderRef(currentRequest.orderId, firestore)),
      )
      if (!existingOrderSnapshot.exists) {
        requestKeyToCreate = currentRequestKey
        requestRefToCreate = currentRequestRef
        break
      }

      const order = { id: existingOrderSnapshot.id, ...existingOrderSnapshot.data() }
      const expiredActiveReservation = order.reservationStatus === 'active' && isExpired(order, now())
      if (
        (!expiredActiveReservation && isReservationEligibleForPayment(order, now()))
        || isRetryableExpiredRazorpayReservation(order, now())
      ) {
        reusableOrder = order
        break
      }

      terminalOrders.push({
        order,
        orderRef: existingOrderSnapshot.ref,
        expiredAt: expiredActiveReservation ? timestamp.now() : null,
      })
      parentRequestRef = currentRequestRef
      currentRequestKey = currentRequest.nextRequestKey
        || nextReservationRequestKey(currentRequestKey, order.reservationId)
      currentRequestRef = firestore.collection('reservationRequests').doc(currentRequestKey)
      currentRequestSnapshot = await withFirestoreDiagnostics(
        FIRESTORE_STAGES.reservationIdempotencyRead,
        () => transaction.get(currentRequestRef),
      )
      if (!currentRequestSnapshot.exists) {
        requestKeyToCreate = currentRequestKey
        requestRefToCreate = currentRequestRef
        break
      }
    }

    if (!requestRefToCreate && !reusableOrder) {
      requestKeyToCreate = currentRequestKey
      requestRefToCreate = currentRequestRef
    }

    const productIds = new Set(normalizedItems.map((item) => item.productId))
    for (const terminal of terminalOrders) {
      for (const item of getReservationItems(terminal.order)) productIds.add(item.productId)
    }
    if (reusableOrder) {
      for (const item of getReservationItems(reusableOrder)) productIds.add(item.productId)
    }
    const productSnapshots = new Map(await Promise.all([...productIds].map(async (id) => [
      id,
      await withFirestoreDiagnostics(
        reusableOrder ? FIRESTORE_STAGES.reservationExistingProductRead : FIRESTORE_STAGES.reservationProductRead,
        () => transaction.get(productRef(id, firestore)),
      ),
    ])))
    const inventoryState = new Map([...productSnapshots]
      .filter(([, snapshot]) => snapshot.exists)
      .map(([id, snapshot]) => [id, snapshot.data()]))
    for (const terminal of terminalOrders) {
      const order = terminal.order
      const release = await releaseReservationStockInTransaction(
        transaction,
        terminal.orderRef,
        order,
        {
          firestore,
          timestamp,
          releasedAt: terminal.expiredAt || undefined,
          reason: terminal.expiredAt
            ? 'Reservation expired on idempotent access'
            : 'Terminal reservation stock reconciliation',
          actionType: terminal.expiredAt ? 'expire' : 'release',
          productSnapshots,
          inventoryState,
        },
      )
      transaction.update(terminal.orderRef, {
        ...release.orderPatch,
        ...(terminal.expiredAt ? {
          reservationStatus: 'expired',
          releasedAt: terminal.expiredAt,
        } : {}),
      })
      order.stockReserved = false
      if (release.orderPatch.stockReleasedAt) {
        order.stockReleasedAt = release.orderPatch.stockReleasedAt
      }
      if (terminal.expiredAt) {
        order.reservationStatus = 'expired'
        order.releasedAt = terminal.expiredAt
      }
    }

    if (reusableOrder) {
      if (isRetryableExpiredRazorpayReservation(reusableOrder, now())) {
        const quantities = getProductQuantities(getReservationItems(reusableOrder))
        if (!quantities.size) {
          throw Object.assign(new Error('The expired reservation has no valid inventory items.'), {
            code: 'RESERVATION_STOCK_MISMATCH',
          })
        }

        const reacquired = new Map()
        if (!hasReservationStock(reusableOrder)) {
          for (const [id, totalQuantity] of quantities) {
            const snapshot = productSnapshots.get(id)
            if (!snapshot?.exists) {
              throw Object.assign(new Error('A reserved product could not be found.'), {
                code: 'PRODUCT_NOT_FOUND',
              })
            }
            const product = inventoryState.get(id)
            reacquired.set(id, {
              product,
              inventory: reserveInventory(product, totalQuantity),
            })
          }

          const reacquiredAt = timestamp.now()
          for (const [id, result] of reacquired) {
            inventoryState.set(id, result.inventory)
            transaction.update(productSnapshots.get(id).ref, result.inventory)
            transaction.set(historyRef(firestore), {
              productId: id,
              actionType: 'reserve',
              quantityChanged: quantities.get(id),
              previousQuantity: normalizeInventory(result.product).reservedStock,
              newQuantity: normalizeInventory(result.inventory).reservedStock,
              reason: 'Inventory revalidated for Razorpay payment retry',
              reservationId: reusableOrder.reservationId,
              orderId: reusableOrder.id,
              timestamp: reacquiredAt,
            })
          }
        }

        const renewedAt = timestamp.now()
        const renewal = {
          reservationStatus: 'active',
          reservedAt: renewedAt,
          expiresAt,
          releasedAt: null,
          stockReserved: true,
          stockReleasedAt: null,
          checkoutAbandoned: false,
          inventoryOwnershipStatus: 'held',
          ...(reacquired.size ? { stockReacquiredAt: renewedAt } : {}),
        }
        transaction.update(orderRef(reusableOrder.id, firestore), renewal)
        Object.assign(reusableOrder, renewal)
      }

      reusableOrder.cancellationToken = makeCancellationToken(
        cancellationSecret,
        reusableOrder.reservationId,
        fingerprint,
      )
      return { order: reusableOrder, products: inventoryState }
    }

    for (const item of normalizedItems) {
      if (!productSnapshots.get(item.productId)?.exists) {
        const error = new Error('Product not found.')
        error.code = 'PRODUCT_NOT_FOUND'
        throw error
      }
    }

    const productQuantities = getProductQuantities(normalizedItems)
    for (const [id, totalQuantity] of productQuantities) {
      inventoryState.set(id, reserveInventory(inventoryState.get(id), totalQuantity))
    }
    for (const id of productQuantities.keys()) {
      transaction.update(productSnapshots.get(id).ref, inventoryState.get(id))
    }

    const orderItems = normalizedItems.map((item) => {
      const product = productSnapshots.get(item.productId).data()
      const price = Number(product.price) || 0
      return {
        productId: item.productId,
        productName: typeof product.name === 'string' ? product.name : '',
        image: product.images?.[0]?.url || product.images?.[0] || '',
        selectedSize: item.selectedSize || product.sizeLength || '',
        quantity: item.quantity,
        price,
        lineSubtotal: price * item.quantity,
      }
    })
    const firstItem = orderItems[0]
    const totalAmount = orderItems.reduce((total, item) => total + item.lineSubtotal, 0)
    const currentTime = timestamp.now()
    const reservationId = randomUUID()
    const cancellationToken = makeCancellationToken(cancellationSecret, reservationId, fingerprint)
    const order = {
      orderType: 'online_order',
      productId: firstItem.productId,
      productName: firstItem.productName,
      price: firstItem.price,
      image: firstItem.image,
      selectedSize: firstItem.selectedSize,
      items: orderItems,
      subtotal: totalAmount,
      totalAmount,
      customer: normalizeCustomer(customer),
      paymentMethod: 'razorpay',
      paymentStatus: 'pending',
      orderStatus: 'initiated',
      reservationId,
      reservationStatus: 'active',
      reservedQuantity: orderItems.reduce((total, item) => total + item.quantity, 0),
      reservedAt: currentTime,
      expiresAt,
      stockReserved: true,
      stockDeducted: false,
      inventoryOwnershipStatus: 'held',
      idempotencyKey: requestKeyToCreate,
      requestFingerprint: fingerprint,
      createdAt: currentTime,
    }

    transaction.set(newOrderRef, order)
    transaction.set(requestRefToCreate, {
      reservationId,
      orderId: newOrderRef.id,
      fingerprint,
      createdAt: currentTime,
    })
    const requestPatches = new Map()
    const addRequestPatch = (ref, patch) => {
      requestPatches.set(ref, { ...(requestPatches.get(ref) || {}), ...patch })
    }
    if (parentRequestRef) {
      addRequestPatch(parentRequestRef, { nextRequestKey: requestKeyToCreate })
    }
    if (rootRequest && requestKeyToCreate !== idempotencyKey) {
      addRequestPatch(requestRef, { latestRequestKey: requestKeyToCreate })
    }
    for (const [ref, patch] of requestPatches) {
      transaction.update(ref, patch)
    }
    transaction.set(firestore.collection('reservationTokens').doc(reservationId), {
      tokenHash: hashCancellationToken(cancellationToken),
      createdAt: currentTime,
    })
    for (const [id, totalQuantity] of productQuantities) {
      const productSnapshot = productSnapshots.get(id)
      transaction.set(historyRef(firestore), {
        productId: id,
        actionType: 'reserve',
        quantityChanged: totalQuantity,
        previousQuantity: normalizeInventory(productSnapshot.data()).reservedStock,
        newQuantity: normalizeInventory(inventoryState.get(id)).reservedStock,
        reason: 'Online checkout inventory hold',
        reservationId,
        orderId: newOrderRef.id,
        timestamp: currentTime,
      })
    }

    return {
      order: { id: newOrderRef.id, ...order, cancellationToken },
      products: inventoryState,
    }
  })
  const result = await withFirestoreDiagnostics(
    FIRESTORE_STAGES.reservationTransaction,
    runReservationTransaction,
  )

  return reservationResponse(result.order, result.products)
}

export async function confirmReservation(reservationId, adminUid, { firestore = db, timestamp = Timestamp } = {}) {
  return firestore.runTransaction(async (transaction) => {
    const orderQuery = await firestore.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
    if (orderQuery.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
    const currentOrderRef = orderQuery.docs[0].ref
    const orderSnapshot = await transaction.get(currentOrderRef)
    const order = orderSnapshot.data()
    const quantities = getProductQuantities(getReservationItems(order))
    const productSnapshots = await getProductSnapshots(transaction, quantities.keys(), firestore)
    if (order.stockRestored) {
      throw Object.assign(new Error('This reservation has already been restocked and cannot be confirmed.'), { code: 'RESERVATION_CONVERTED' })
    }
    if (order.reservationStatus === 'converted' && order.stockDeducted) {
      if (order.orderStatus !== 'confirmed') {
        throw Object.assign(new Error('Reservation is converted but its persisted order status is inconsistent.'), { code: 'RESERVATION_STATUS_INCONSISTENT' })
      }
      return {
        status: 'converted',
        orderId: orderSnapshot.id,
        orderStatus: order.orderStatus,
        reservationStatus: order.reservationStatus,
      }
    }
    if (order.paymentStatus !== 'captured') {
      throw Object.assign(new Error('Order confirmation is automatic after verified captured payment.'), { code: 'AUTOMATIC_CONFIRMATION_REQUIRED' })
    }
    if (order.paymentReconciliationStatus === 'manual_review' || order.refundRequired === true) {
      throw Object.assign(new Error('This captured payment requires manual inventory or refund resolution.'), { code: 'PAYMENT_REQUIRES_REFUND' })
    }
    if (order.reservationStatus !== 'active') throw Object.assign(new Error('This reservation is no longer active.'), { code: 'RESERVATION_NOT_ACTIVE' })
    if (isExpired(order)) {
      const now = timestamp.now()
      const release = await releaseReservationStockInTransaction(transaction, currentOrderRef, order, {
        firestore,
        timestamp,
        releasedAt: now,
        reason: 'Checkout hold expired before payment confirmation',
        actionType: 'expire',
        adminUid,
        productSnapshots,
      })
      transaction.update(currentOrderRef, {
        ...release.orderPatch,
        reservationStatus: 'expired',
        releasedAt: now,
        orderStatus: 'initiated',
      })
      return { status: 'expired', orderId: currentOrderRef.id }
    }
    const inventoryUpdates = new Map()
    try {
      for (const [productId, quantity] of quantities) {
        const product = productSnapshots.get(productId)?.data()
        if (!product) throw Object.assign(new Error('Product no longer exists.'), { code: 'PRODUCT_NOT_FOUND' })
        const inventorySource = hasReservationStock(order)
          ? product
          : reserveInventory(product, quantity)
        inventoryUpdates.set(productId, {
          product,
          inventory: convertInventory(inventorySource, quantity),
        })
      }
    } catch (error) {
      if (
        order.paymentMethod === 'razorpay'
        && order.paymentStatus === 'captured'
        && ['INSUFFICIENT_STOCK', 'RESERVATION_MISMATCH'].includes(error?.code)
      ) {
        transaction.update(currentOrderRef, {
          paymentReconciliationStatus: 'manual_review',
          paymentReconciliationReason: 'captured_payment_without_available_inventory',
          refundRequired: true,
        })
        return { status: 'manual_review', orderId: currentOrderRef.id }
      }
      if (error?.code === 'PRODUCT_NOT_FOUND') {
        throw Object.assign(error, { code: 'PRODUCT_NOT_FOUND' })
      }
      throw error
    }
    const now = timestamp.now()
    for (const [productId, result] of inventoryUpdates) {
      const productSnapshot = productSnapshots.get(productId)
      transaction.update(productSnapshot.ref, result.inventory)
      transaction.set(historyRef(firestore), {
        productId,
        actionType: 'convert',
        quantityChanged: -quantities.get(productId),
        previousQuantity: normalizeInventory(result.product).totalStock,
        newQuantity: result.inventory.totalStock,
        reason: 'Captured payment converted to confirmed order',
        reservationId,
        orderId: currentOrderRef.id,
        adminUid,
        timestamp: now,
      })
    }
    transaction.update(currentOrderRef, {
      reservationStatus: 'converted',
      convertedAt: now,
      stockReserved: false,
      stockReleasedAt: null,
      stockDeducted: true,
      inventoryOwnershipStatus: 'consumed',
      paymentReconciliationStatus: null,
      orderStatus: 'confirmed',
    })
    return {
      status: 'converted',
      orderId: currentOrderRef.id,
      orderStatus: 'confirmed',
      reservationStatus: 'converted',
    }
  })
}

export async function releaseReservation(reservationId, adminUid, reason = 'Reservation released', {
  firestore = db,
  timestamp = Timestamp,
  reconcilePayment,
} = {}) {
  const matchingOrder = await firestore.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
  if (matchingOrder.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
  const reconciliation = await reconcileReservationPayment(matchingOrder.docs[0].data(), {
    firestore,
    timestamp,
    reconcilePayment,
  })
  assertReservationPaymentResolved(reconciliation)

  return firestore.runTransaction(async (transaction) => {
    const currentOrderRef = matchingOrder.docs[0].ref
    const orderSnapshot = await transaction.get(currentOrderRef)
    const order = orderSnapshot.data()
    if (isCapturedRazorpayPayment(order)) assertReservationPaymentResolved({ status: 'captured' })
    if (hasUnsettledRazorpayPayment(order)) assertReservationPaymentResolved({ status: 'pending' })
    if (order.reservationStatus === 'released' || order.reservationStatus === 'expired') return { status: order.reservationStatus, orderId: currentOrderRef.id }
    if (order.reservationStatus !== 'active') throw Object.assign(new Error('Converted reservations require a restock cancellation.'), { code: 'RESERVATION_CONVERTED' })
    const now = timestamp.now()
    const expired = isExpired(order, now.toMillis())
    const release = await releaseReservationStockInTransaction(transaction, currentOrderRef, order, {
      firestore,
      timestamp,
      releasedAt: now,
      reason: expired ? 'Reservation expired before release' : reason,
      actionType: expired ? 'expire' : 'release',
      adminUid,
    })
    transaction.update(currentOrderRef, {
      ...release.orderPatch,
      reservationStatus: expired ? 'expired' : 'released',
      releasedAt: now,
      ...(expired ? {} : { cancelledAt: now }),
    })
    return { status: expired ? 'expired' : 'released', orderId: currentOrderRef.id }
  })
}

export async function cancelReservation(reservationId, cancellationToken, {
  firestore = db,
  timestamp = Timestamp,
  reconcilePayment,
} = {}) {
  const matchingOrder = await firestore.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
  if (matchingOrder.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
  const reservationRef = matchingOrder.docs[0].ref
  const tokenSnapshot = await firestore.collection('reservationTokens').doc(reservationId).get()
  if (!tokenSnapshot.exists || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)) {
    throw Object.assign(new Error('Invalid reservation cancellation token.'), { code: 'INVALID_CANCELLATION_TOKEN' })
  }
  const reconciliation = await reconcileReservationPayment(matchingOrder.docs[0].data(), {
    firestore,
    timestamp,
    reconcilePayment,
  })
  assertReservationPaymentResolved(reconciliation)

  return firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(reservationRef)
    const order = orderSnapshot.data()
    const currentTokenSnapshot = await transaction.get(firestore.collection('reservationTokens').doc(reservationId))
    if (!currentTokenSnapshot.exists || !cancellationTokenMatches(cancellationToken, currentTokenSnapshot.data().tokenHash)) {
      throw Object.assign(new Error('Invalid reservation cancellation token.'), { code: 'INVALID_CANCELLATION_TOKEN' })
    }
    if (isCapturedRazorpayPayment(order)) assertReservationPaymentResolved({ status: 'captured' })
    if (hasUnsettledRazorpayPayment(order)) assertReservationPaymentResolved({ status: 'pending' })
    if (order.reservationStatus === 'released' || order.reservationStatus === 'expired') {
      return { status: order.reservationStatus, orderId: reservationRef.id }
    }
    if (order.reservationStatus !== 'active') {
      throw Object.assign(new Error('Converted reservations cannot be cancelled through this endpoint.'), { code: 'RESERVATION_CONVERTED' })
    }
    const now = timestamp.now()
    const expired = isExpired(order, now.toMillis())
    const release = await releaseReservationStockInTransaction(transaction, reservationRef, order, {
      firestore,
      timestamp,
      releasedAt: now,
      reason: expired ? 'Reservation expired before customer cancellation' : 'Cancelled by customer',
      actionType: expired ? 'expire' : 'release',
    })
    transaction.update(reservationRef, {
      ...release.orderPatch,
      reservationStatus: expired ? 'expired' : 'released',
      releasedAt: now,
      ...(expired ? {} : { cancelledAt: now }),
    })
    return { status: expired ? 'expired' : 'released', orderId: reservationRef.id }
  })
}

export async function getCustomerReservationStatus(reservationId, cancellationToken, {
  firestore = db,
  now = Date.now,
} = {}) {
  const tokenSnapshot = await withFirestoreDiagnostics(
    FIRESTORE_STAGES.statusTokenRead,
    () => firestore.collection('reservationTokens').doc(reservationId).get(),
  )
  if (!tokenSnapshot.exists || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)) {
    throw Object.assign(new Error('Invalid reservation access token.'), { code: 'INVALID_CANCELLATION_TOKEN' })
  }

  const matchingOrder = await withFirestoreDiagnostics(
    FIRESTORE_STAGES.statusOrdersQuery,
    () => firestore.collection('orders').where('reservationId', '==', reservationId).limit(1).get(),
  )
  if (matchingOrder.empty) {
    throw Object.assign(new Error('Reservation record not found.'), { code: 'RESERVATION_NOT_FOUND' })
  }

  const orderSnapshot = matchingOrder.docs[0]
  const order = orderSnapshot.data()
  let status = 'unavailable'
  if (order.orderStatus === 'delivered' || order.orderStatus === 'completed') status = 'delivered'
  else if (order.orderStatus === 'cancelled' || order.reservationStatus === 'released') status = 'cancelled'
  else if (['confirmed', 'processing', 'shipped'].includes(order.orderStatus)) status = order.orderStatus
  else if (order.reservationStatus === 'converted') status = 'confirmed'
  else if (order.reservationStatus === 'expired' || (order.reservationStatus === 'active' && isExpired(order, now()))) status = 'expired'
  else if (order.reservationStatus === 'active') status = 'pending'

  const paymentAttempts = Object.values(order.paymentAttempts || {})
  const capturedPayment = isCapturedRazorpayPayment(order)
  const failedPayment = paymentAttempts.length > 0
    && paymentAttempts.every((attempt) => attempt?.status === 'failed'
      && Object.values(attempt?.payments || {}).every((payment) => payment?.status === 'failed'))
  const authorizedPayment = paymentAttempts.some((attempt) => attempt?.status === 'authorized'
    || Object.values(attempt?.payments || {}).some((payment) => payment?.status === 'authorized'))
  const paymentStatus = paymentAttempts.length === 0
    ? (['pending', 'authorized', 'captured', 'failed'].includes(order.paymentStatus)
      ? order.paymentStatus
      : 'pending')
    : capturedPayment
      ? 'captured'
      : authorizedPayment
        ? 'authorized'
        : failedPayment
          ? 'failed'
          : 'pending'
  const inventoryStatus = hasReservationStock(order)
    ? 'held'
    : order.checkoutAbandoned === true
      ? 'released'
    : order.paymentReconciliationStatus === 'manual_review'
      ? 'manual_review'
      : order.paymentReconciliationStatus
        ? 'released_pending_verification'
        : 'released'
  const items = getReservationItems(order).map((item) => ({
    ...item,
    lineSubtotal: Number(item.price || 0) * item.quantity,
  }))

  return {
    reservationId,
    orderId: orderSnapshot.id,
    status,
    paymentStatus,
    inventoryStatus,
    paymentReconciliationStatus: order.paymentReconciliationStatus || null,
    paymentMethod: order.paymentMethod === 'razorpay' ? 'razorpay' : 'historical',
    productName: typeof order.productName === 'string' ? order.productName : '',
    price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
    reservedQuantity: Number.isInteger(order.reservedQuantity) ? order.reservedQuantity : null,
    items,
    totalAmount: Number.isFinite(Number(order.totalAmount))
      ? Number(order.totalAmount)
      : Number.isFinite(Number(order.subtotal))
        ? Number(order.subtotal)
        : items.reduce((total, item) => total + item.lineSubtotal, 0),
    paymentAmountPaise: Number.isSafeInteger(order.paymentAmountPaise) ? order.paymentAmountPaise : null,
    orderStatus: order.orderStatus || 'initiated',
    paymentId: typeof order.razorpayPaymentId === 'string' ? order.razorpayPaymentId : '',
    createdAt: getOrderCreatedAtIso(order.createdAt),
    expiresAt: order.expiresAt?.toDate?.().toISOString() || order.expiresAt?.toISOString?.() || null,
  }
}

export async function restockConvertedOrder(reservationId, adminUid, reason = 'Converted order cancelled and restocked', { firestore = db, timestamp = Timestamp } = {}) {
  return firestore.runTransaction(async (transaction) => {
    const orderQuery = await firestore.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
    if (orderQuery.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
    const orderRefFound = orderQuery.docs[0].ref
    const orderSnapshot = await transaction.get(orderRefFound)
    const order = orderSnapshot.data()
    if (!order.stockDeducted || order.reservationStatus !== 'converted') {
      throw Object.assign(new Error('This order has not deducted stock.'), { code: 'NOT_STOCK_DEDUCTED' })
    }
    if (order.stockRestored) {
      if (order.orderStatus !== 'cancelled') {
        throw Object.assign(new Error('Restock is recorded, but the persisted order status is inconsistent.'), { code: 'RESERVATION_STATUS_INCONSISTENT' })
      }
      return {
        status: 'restocked',
        orderId: orderRefFound.id,
        orderStatus: order.orderStatus,
        reservationStatus: order.reservationStatus,
        stockRestored: true,
        stockRestoredAt: order.stockRestoredAt?.toDate?.().toISOString()
          || order.stockRestoredAt?.toISOString?.()
          || null,
      }
    }
    if (hasUnsettledRazorpayPayment(order)) {
      throw Object.assign(new Error('Resolve or refund the Razorpay payment before restocking this order.'), { code: 'PAYMENT_REQUIRES_REFUND' })
    }
    const quantities = getProductQuantities(getReservationItems(order))
    const productSnapshots = await getProductSnapshots(transaction, quantities.keys(), firestore)
    if ([...productSnapshots.values()].some((snapshot) => !snapshot.exists)) {
      throw Object.assign(new Error('A product in this order no longer exists.'), { code: 'PRODUCT_NOT_FOUND' })
    }
    const inventoryUpdates = new Map([...quantities].map(([productId, quantity]) => {
      const product = productSnapshots.get(productId).data()
      const inventory = normalizeInventory(product)
      const totalStock = inventory.totalStock + quantity
      return [productId, {
        product,
        inventory,
        updated: {
          totalStock,
          reservedStock: inventory.reservedStock,
          availableStock: inventory.availableStock + quantity,
          inStock: inventory.availableStock + quantity > 0,
        },
      }]
    }))
    const now = timestamp.now()
    for (const [productId, result] of inventoryUpdates) {
      transaction.update(productSnapshots.get(productId).ref, result.updated)
      transaction.set(historyRef(firestore), {
        productId,
        actionType: 'restock',
        quantityChanged: quantities.get(productId),
        previousQuantity: result.inventory.totalStock,
        newQuantity: result.updated.totalStock,
        reason,
        reservationId,
        orderId: orderRefFound.id,
        adminUid,
        timestamp: now,
      })
    }
    transaction.update(orderRefFound, {
      stockRestored: true,
      stockRestoredAt: now,
      stockReserved: false,
      inventoryOwnershipStatus: 'released',
      orderStatus: 'cancelled',
    })
    return {
      status: 'restocked',
      orderId: orderRefFound.id,
      orderStatus: 'cancelled',
      reservationStatus: order.reservationStatus,
      stockRestored: true,
      stockRestoredAt: now.toDate().toISOString(),
    }
  })
}

export async function expireReservation(orderSnapshot, {
  firestore = db,
  timestamp = Timestamp,
  reconcilePayment,
} = {}) {
  const order = orderSnapshot.data()
  if (order.reservationStatus !== 'active' || !isExpired(order)) return false
  let reconciliation
  let reconciliationUnavailable = false
  try {
    reconciliation = await reconcileReservationPayment(order, { firestore, timestamp, reconcilePayment })
  } catch (error) {
    if (error?.code !== 'PAYMENT_STATUS_UNAVAILABLE') throw error
    reconciliationUnavailable = true
    reconciliation = { status: 'pending' }
  }
  if (reconciliation.status === 'captured') {
    throw Object.assign(new Error('A Razorpay payment was captured. The reservation was kept for payment review.'), { code: 'PAYMENT_CAPTURED' })
  }
  const paymentUnresolved = reconciliationUnavailable
    || !['failed', 'not_applicable'].includes(reconciliation.status)
  const productSnapshot = await firestore.runTransaction(async (transaction) => {
    const currentOrder = await transaction.get(orderSnapshot.ref)
    const current = currentOrder.data()
    if (current.reservationStatus !== 'active' || !isExpired(current)) return null
    if (isCapturedRazorpayPayment(current)) return null
    const unresolved = paymentUnresolved || hasUnsettledRazorpayPayment(current)
    const now = timestamp.now()
    const release = await releaseReservationStockInTransaction(transaction, orderSnapshot.ref, current, {
      firestore,
      timestamp,
      releasedAt: now,
      reason: 'Reservation expired',
      actionType: 'expire',
    })
    transaction.update(orderSnapshot.ref, {
      ...release.orderPatch,
      reservationStatus: 'expired',
      releasedAt: now,
      ...(unresolved ? {
        inventoryOwnershipStatus: 'released_pending_verification',
        paymentReconciliationStatus: 'pending',
        paymentReconciliationReason: reconciliationUnavailable
          ? 'payment_status_unavailable_at_expiry'
          : 'payment_unresolved_at_expiry',
        ...(current.paymentMethod === 'razorpay' ? {
          checkoutAbandoned: true,
          checkoutStatus: 'expired',
        } : {}),
      } : {}),
    })
    return true
  })
  return Boolean(productSnapshot)
}

export async function expireReservationById(reservationId, options = {}) {
  const query = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
  if (query.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
  return expireReservation(query.docs[0], options)
}

export async function getReservationOrders({ limit = CLEANUP_PAGE_SIZE, after = null } = {}) {
  let query = db.collection('orders')
    .where('reservationStatus', '==', 'active')
    .where('expiresAt', '<=', Timestamp.now())
    .orderBy('expiresAt', 'asc')
    .orderBy('__name__', 'asc')
    .limit(limit)
  if (after) query = query.startAfter(after)
  return query.get()
}

export { adjustInventory, db, isExpired }
