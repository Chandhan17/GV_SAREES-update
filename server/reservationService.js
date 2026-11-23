import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { getFirestore } from 'firebase-admin/firestore'
import { Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'
import { adjustInventory, convertInventory, normalizeInventory, releaseInventory, reserveInventory } from './inventory.js'
import { cancellationTokenMatches, hashCancellationToken, isReservationExpired, makeCancellationToken, normalizeCustomer, reservationFingerprint } from './reservationSecurity.js'

const db = getFirestore()
const DEFAULT_WHATSAPP_EXPIRY_MINUTES = 30
const CLEANUP_PAGE_SIZE = 50

function productRef(productId) {
  return db.collection('products').doc(productId)
}

function orderRef(orderId) {
  return db.collection('orders').doc(orderId)
}

function historyRef() {
  return db.collection('inventoryHistory').doc()
}

function isExpired(order, now = Date.now()) {
  return isReservationExpired(order.expiresAt, now)
}

function reservationResponse(order, product) {
  return {
    reservationId: order.reservationId,
    orderId: order.id,
    reservationStatus: order.reservationStatus,
    reservedQuantity: order.reservedQuantity,
    expiresAt: order.expiresAt?.toDate?.().toISOString() || order.expiresAt?.toISOString?.() || null,
    availableStock: normalizeInventory(product).availableStock,
    productName: order.productName,
    price: order.price,
    cancellationToken: order.cancellationToken,
  }
}

export async function createWhatsAppReservation({
  productId,
  quantity,
  customer,
  selectedSize,
  idempotencyKey,
  expiryMinutes = DEFAULT_WHATSAPP_EXPIRY_MINUTES,
}) {
  const fingerprint = reservationFingerprint({ productId, quantity, selectedSize, customer })
  const cancellationSecret = process.env.RESERVATION_TOKEN_SECRET
  if (!cancellationSecret || Buffer.byteLength(cancellationSecret) < 32) {
    throw new Error('Reservation cancellation is not configured.')
  }
  const requestRef = db.collection('reservationRequests').doc(idempotencyKey)
  const newOrderRef = db.collection('orders').doc()
  const expiresAt = Timestamp.fromMillis(Date.now() + expiryMinutes * 60 * 1000)

  const result = await db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef)

    if (requestSnapshot.exists) {
      const existing = requestSnapshot.data()
      if (existing.fingerprint !== fingerprint) {
        throw Object.assign(new Error('This idempotency key was already used for a different request.'), { code: 'IDEMPOTENCY_CONFLICT' })
      }
      const existingOrderSnapshot = await transaction.get(orderRef(existing.orderId))
      if (existingOrderSnapshot.exists) {
        const order = { id: existingOrderSnapshot.id, ...existingOrderSnapshot.data() }
        const productSnapshot = await transaction.get(productRef(order.productId))
        let currentProduct = productSnapshot.exists ? productSnapshot.data() : {}
        if (order.reservationStatus === 'active' && isExpired(order)) {
          const inventory = releaseInventory(currentProduct, order.reservedQuantity)
          const now = Timestamp.now()
          if (productSnapshot.exists) transaction.update(productSnapshot.ref, inventory)
          currentProduct = { ...currentProduct, ...inventory }
          transaction.update(existingOrderSnapshot.ref, { reservationStatus: 'expired', releasedAt: now })
          transaction.set(historyRef(), {
            productId: order.productId,
            actionType: 'expire',
            quantityChanged: -order.reservedQuantity,
            previousQuantity: normalizeInventory(productSnapshot.data() || {}).reservedStock,
            newQuantity: inventory.reservedStock,
            reason: 'Reservation expired on idempotent access',
            reservationId: order.reservationId,
            orderId: existingOrderSnapshot.id,
            timestamp: now,
          })
          order.reservationStatus = 'expired'
          order.releasedAt = now
        }
        order.cancellationToken = makeCancellationToken(cancellationSecret, order.reservationId, fingerprint)
        return { order, product: currentProduct }
      }
    }

    const productSnapshot = await transaction.get(productRef(productId))
    if (!productSnapshot.exists) {
      const error = new Error('Product not found.')
      error.code = 'PRODUCT_NOT_FOUND'
      throw error
    }

    const product = productSnapshot.data()
    const inventory = reserveInventory(product, quantity)
    const now = Timestamp.now()
    const reservationId = randomUUID()
    const cancellationToken = makeCancellationToken(cancellationSecret, reservationId, fingerprint)
    const order = {
      productId,
      productName: product.name || '',
      price: Number(product.price) || 0,
      image: product.images?.[0]?.url || product.images?.[0] || '',
      selectedSize: selectedSize || product.sizeLength || '',
      customer: normalizeCustomer(customer),
      paymentMethod: 'whatsapp',
      paymentStatus: 'pending',
      orderStatus: 'initiated',
      reservationId,
      reservationStatus: 'active',
      reservedQuantity: quantity,
      reservedAt: now,
      expiresAt,
      stockDeducted: false,
      idempotencyKey,
      requestFingerprint: fingerprint,
      createdAt: now,
    }

    transaction.update(productRef(productId), inventory)
    transaction.set(newOrderRef, order)
    transaction.set(requestRef, {
      reservationId,
      orderId: newOrderRef.id,
      fingerprint,
      createdAt: now,
    })
    transaction.set(db.collection('reservationTokens').doc(reservationId), {
      tokenHash: hashCancellationToken(cancellationToken),
      createdAt: now,
    })
    transaction.set(historyRef(), {
      productId,
      actionType: 'reserve',
      quantityChanged: quantity,
      previousQuantity: normalizeInventory(product).reservedStock,
      newQuantity: inventory.reservedStock,
      reason: 'WhatsApp enquiry reservation',
      reservationId,
      orderId: newOrderRef.id,
      timestamp: now,
    })

    return { order: { id: newOrderRef.id, ...order, cancellationToken }, product: { ...product, ...inventory } }
  })

  return reservationResponse(result.order, result.product)
}

export async function confirmReservation(reservationId, adminUid) {
  return db.runTransaction(async (transaction) => {
    const orderQuery = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
    if (orderQuery.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
    const currentOrderRef = orderQuery.docs[0].ref
    const [orderSnapshot, productSnapshot] = await Promise.all([
      transaction.get(currentOrderRef),
      transaction.get(productRef(orderQuery.docs[0].data().productId)),
    ])
    const order = orderSnapshot.data()
    if (order.reservationStatus === 'converted' && order.stockDeducted) return { status: 'converted', orderId: orderSnapshot.id }
    if (order.reservationStatus !== 'active') throw Object.assign(new Error('This reservation is no longer active.'), { code: 'RESERVATION_NOT_ACTIVE' })
    if (isExpired(order)) {
      const inventory = releaseInventory(productSnapshot.data(), order.reservedQuantity)
      const now = Timestamp.now()
      transaction.update(productSnapshot.ref, inventory)
      transaction.update(currentOrderRef, { reservationStatus: 'expired', releasedAt: now, orderStatus: 'initiated' })
      transaction.set(historyRef(), {
        productId: order.productId,
        actionType: 'expire',
        quantityChanged: -order.reservedQuantity,
        previousQuantity: normalizeInventory(productSnapshot.data()).reservedStock,
        newQuantity: inventory.reservedStock,
        reason: 'Reservation expired before admin confirmation',
        reservationId,
        orderId: currentOrderRef.id,
        adminUid,
        timestamp: now,
      })
      return { status: 'expired', orderId: currentOrderRef.id }
    }
    const inventory = convertInventory(productSnapshot.data(), order.reservedQuantity)
    const now = Timestamp.now()
    transaction.update(productSnapshot.ref, inventory)
    transaction.update(currentOrderRef, { reservationStatus: 'converted', convertedAt: now, stockDeducted: true, orderStatus: 'confirmed' })
    transaction.set(historyRef(), {
      productId: order.productId,
      actionType: 'convert',
      quantityChanged: -order.reservedQuantity,
      previousQuantity: normalizeInventory(productSnapshot.data()).totalStock,
      newQuantity: inventory.totalStock,
      reason: 'Reservation confirmed by admin',
      reservationId,
      orderId: currentOrderRef.id,
      adminUid,
      timestamp: now,
    })
    return { status: 'converted', orderId: currentOrderRef.id }
  })
}

export async function releaseReservation(reservationId, adminUid, reason = 'Reservation released') {
  return db.runTransaction(async (transaction) => {
    const orderQuery = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
    if (orderQuery.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
    const currentOrderRef = orderQuery.docs[0].ref
    const orderSnapshot = await transaction.get(currentOrderRef)
    const order = orderSnapshot.data()
    if (order.reservationStatus === 'released' || order.reservationStatus === 'expired') return { status: order.reservationStatus, orderId: currentOrderRef.id }
    if (order.reservationStatus !== 'active') throw Object.assign(new Error('Converted reservations require a restock cancellation.'), { code: 'RESERVATION_CONVERTED' })
    const productSnapshot = await transaction.get(productRef(order.productId))
    const inventory = releaseInventory(productSnapshot.data(), order.reservedQuantity)
    const now = Timestamp.now()
    const expired = isExpired(order, now.toMillis())
    transaction.update(productSnapshot.ref, inventory)
    transaction.update(currentOrderRef, {
      reservationStatus: expired ? 'expired' : 'released',
      releasedAt: now,
      ...(expired ? {} : { cancelledAt: now }),
    })
    transaction.set(historyRef(), {
      productId: order.productId,
      actionType: expired ? 'expire' : 'release',
      quantityChanged: -order.reservedQuantity,
      previousQuantity: normalizeInventory(productSnapshot.data()).reservedStock,
      newQuantity: inventory.reservedStock,
      reason: expired ? 'Reservation expired before release' : reason,
      reservationId,
      orderId: currentOrderRef.id,
      adminUid,
      timestamp: now,
    })
    return { status: expired ? 'expired' : 'released', orderId: currentOrderRef.id }
  })
}

export async function cancelReservation(reservationId, cancellationToken) {
  const matchingOrder = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
  if (matchingOrder.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
  const reservationRef = matchingOrder.docs[0].ref
  return db.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(reservationRef)
    const order = orderSnapshot.data()
    const tokenSnapshot = await transaction.get(db.collection('reservationTokens').doc(reservationId))
    if (!tokenSnapshot.exists || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)) {
      throw Object.assign(new Error('Invalid reservation cancellation token.'), { code: 'INVALID_CANCELLATION_TOKEN' })
    }
    if (order.reservationStatus === 'released' || order.reservationStatus === 'expired') {
      return { status: order.reservationStatus, orderId: reservationRef.id }
    }
    if (order.reservationStatus !== 'active') {
      throw Object.assign(new Error('Converted reservations cannot be cancelled through this endpoint.'), { code: 'RESERVATION_CONVERTED' })
    }
    const productSnapshot = await transaction.get(productRef(order.productId))
    if (!productSnapshot.exists) throw Object.assign(new Error('Product no longer exists.'), { code: 'PRODUCT_NOT_FOUND' })
    const inventory = releaseInventory(productSnapshot.data(), order.reservedQuantity)
    const now = Timestamp.now()
    const expired = isExpired(order, now.toMillis())
    transaction.update(productSnapshot.ref, inventory)
    transaction.update(reservationRef, {
      reservationStatus: expired ? 'expired' : 'released',
      releasedAt: now,
      ...(expired ? {} : { cancelledAt: now }),
    })
    transaction.set(historyRef(), {
      productId: order.productId,
      actionType: expired ? 'expire' : 'release',
      quantityChanged: -order.reservedQuantity,
      previousQuantity: normalizeInventory(productSnapshot.data()).reservedStock,
      newQuantity: inventory.reservedStock,
      reason: expired ? 'Reservation expired before customer cancellation' : 'Cancelled by customer',
      reservationId,
      orderId: reservationRef.id,
      timestamp: now,
    })
    return { status: expired ? 'expired' : 'released', orderId: reservationRef.id }
  })
}

export async function restockConvertedOrder(reservationId, adminUid, reason = 'Converted order cancelled and restocked') {
  return db.runTransaction(async (transaction) => {
    const orderQuery = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
    if (orderQuery.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
    const orderRefFound = orderQuery.docs[0].ref
    const orderSnapshot = await transaction.get(orderRefFound)
    const order = orderSnapshot.data()
    if (!order.stockDeducted || order.reservationStatus !== 'converted') {
      throw Object.assign(new Error('This order has not deducted stock.'), { code: 'NOT_STOCK_DEDUCTED' })
    }
    if (order.stockRestored) return { status: 'restocked', orderId: orderRefFound.id }
    const productRefFound = productRef(order.productId)
    const productSnapshot = await transaction.get(productRefFound)
    const inventory = normalizeInventory(productSnapshot.data())
    const now = Timestamp.now()
    transaction.update(productRefFound, {
      totalStock: inventory.totalStock + order.reservedQuantity,
      reservedStock: inventory.reservedStock,
      availableStock: inventory.availableStock + order.reservedQuantity,
      inStock: inventory.availableStock + order.reservedQuantity > 0,
    })
    transaction.update(orderRefFound, {
      stockRestored: true,
      stockRestoredAt: now,
      orderStatus: 'cancelled',
    })
    transaction.set(historyRef(), {
      productId: order.productId,
      actionType: 'restock',
      quantityChanged: order.reservedQuantity,
      previousQuantity: inventory.totalStock,
      newQuantity: inventory.totalStock + order.reservedQuantity,
      reason,
      reservationId,
      orderId: orderRefFound.id,
      adminUid,
      timestamp: now,
    })
    return { status: 'restocked', orderId: orderRefFound.id }
  })
}

export async function expireReservation(orderSnapshot) {
  const order = orderSnapshot.data()
  if (order.reservationStatus !== 'active' || !isExpired(order)) return false
  const productSnapshot = await db.runTransaction(async (transaction) => {
    const currentOrder = await transaction.get(orderSnapshot.ref)
    const current = currentOrder.data()
    if (current.reservationStatus !== 'active' || !isExpired(current)) return null
    const product = await transaction.get(productRef(current.productId))
    const inventory = releaseInventory(product.data(), current.reservedQuantity)
    const now = Timestamp.now()
    transaction.update(product.ref, inventory)
    transaction.update(orderSnapshot.ref, { reservationStatus: 'expired', releasedAt: now })
    transaction.set(historyRef(), {
      productId: current.productId,
      actionType: 'expire',
      quantityChanged: -current.reservedQuantity,
      previousQuantity: normalizeInventory(product.data()).reservedStock,
      newQuantity: inventory.reservedStock,
      reason: 'Reservation expired',
      reservationId: current.reservationId,
      orderId: orderSnapshot.id,
      timestamp: now,
    })
    return true
  })
  return Boolean(productSnapshot)
}

export async function expireReservationById(reservationId) {
  const query = await db.collection('orders').where('reservationId', '==', reservationId).limit(1).get()
  if (query.empty) throw Object.assign(new Error('Reservation not found.'), { code: 'RESERVATION_NOT_FOUND' })
  return expireReservation(query.docs[0])
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
