import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import Razorpay from 'razorpay'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'
import { hasReservationStock, normalizeInventory, reserveInventory } from './inventory.js'
import {
  fulfillCapturedReservationInTransaction,
  getReservationItems,
  isReservationEligibleForPayment,
  releaseReservationStockInTransaction,
} from './reservationService.js'
import { cancellationTokenMatches } from './reservationSecurity.js'

const db = getFirestore()
const PAYMENT_CURRENCY = 'INR'
const MAX_AMOUNT_PAISE = 50_000_000
const MAX_PAYMENT_ATTEMPTS = 20
const PAYMENT_RECONCILIATION_TIMEOUT_MS = 8_000

function paymentError(code, message) {
  return Object.assign(new Error(message), { code })
}

function getPaymentConfiguration({
  keyId = process.env.RAZORPAY_KEY_ID,
  publicKeyId = process.env.VITE_RAZORPAY_KEY_ID,
  keySecret = process.env.RAZORPAY_KEY_SECRET,
} = {}) {
  if (!keyId || !publicKeyId || !keySecret) {
    throw paymentError('PAYMENT_NOT_CONFIGURED', 'Razorpay test credentials are not configured.')
  }
  if (!keyId.startsWith('rzp_test_') || publicKeyId !== keyId) {
    throw paymentError('TEST_MODE_REQUIRED', 'Only matching Razorpay test-mode credentials are supported.')
  }
  return { keyId, publicKeyId, keySecret }
}

function createRazorpayClient(configuration) {
  return new Razorpay({
    key_id: configuration.keyId,
    key_secret: configuration.keySecret,
  })
}

export function getRazorpayPaymentConfiguration(options) {
  return getPaymentConfiguration(options)
}

export function createRazorpayTestClient(options) {
  return createRazorpayClient(getPaymentConfiguration(options))
}

function idempotencyHash(idempotencyKey) {
  return createHash('sha256').update(idempotencyKey).digest('hex')
}

export function calculateRazorpayAmountPaise(unitPrice, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100_000) {
    throw paymentError('INVALID_QUANTITY', 'Reservation quantity is invalid.')
  }
  const price = Number(unitPrice)
  const amountPaise = Math.round(price * 100 * quantity)
  if (
    !Number.isFinite(price)
    || price <= 0
    || !Number.isSafeInteger(amountPaise)
    || Math.abs(price * 100 - Math.round(price * 100)) > 1e-7
    || amountPaise > MAX_AMOUNT_PAISE
  ) {
    throw paymentError('INVALID_AMOUNT', 'Reservation price cannot be processed.')
  }
  return amountPaise
}

export function calculateRazorpayItemsAmountPaise(items) {
  if (!Array.isArray(items) || !items.length) {
    throw paymentError('INVALID_AMOUNT', 'Reservation items cannot be processed.')
  }
  const amount = items.reduce((total, item) => {
    const lineAmount = calculateRazorpayAmountPaise(item.price, item.quantity)
    if (!Number.isSafeInteger(total + lineAmount) || total + lineAmount > MAX_AMOUNT_PAISE) {
      throw paymentError('INVALID_AMOUNT', 'Reservation price cannot be processed.')
    }
    return total + lineAmount
  }, 0)
  return amount
}

function verifiedSignatureMatches(orderId, paymentId, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest()
  const received = Buffer.from(signature, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function getPaymentAttempts(order) {
  return order.paymentAttempts && typeof order.paymentAttempts === 'object'
    ? order.paymentAttempts
    : {}
}

function findAttemptByOrderId(order, razorpayOrderId) {
  return Object.entries(getPaymentAttempts(order))
    .find(([, attempt]) => attempt?.razorpayOrderId === razorpayOrderId)
}

function findAttemptByReceipt(order, receipt) {
  return Object.entries(getPaymentAttempts(order))
    .find(([, attempt]) => attempt?.receipt === receipt)
}

function isPaymentBlockingNewAttempt(status) {
  return status === 'pending' || status === 'authorized' || status === 'captured'
}

function hasActivePaymentAttempt(paymentAttempts) {
  return Object.values(paymentAttempts).some((attempt) =>
    isPaymentBlockingNewAttempt(attempt?.status),
  )
}

function hasUnresolvedPaymentAttempt(paymentAttempts) {
  return Object.values(paymentAttempts).some((attempt) => (
    getEffectiveAttemptStatus(attempt) !== 'failed'
  ))
}

function getEffectiveAttemptStatus(attempt = {}) {
  const paymentStatuses = Object.values(attempt.payments || {})
    .map((payment) => payment?.status)
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

function shouldReleaseReservationStockAfterFailure(order, paymentAttempts, attemptKey, attemptStatus) {
  return order.paymentIdempotencyKeyHash === attemptKey
    && attemptStatus === 'failed'
    && order.paymentStatus !== 'captured'
    && !hasUnresolvedPaymentAttempt(paymentAttempts)
}

function assertReservationCanBePaid(order, now) {
  if (!isReservationEligibleForPayment(order, now)) {
    throw paymentError('RESERVATION_NOT_PAYABLE', 'This reservation is no longer available for payment.')
  }
}

function lookupOrderByReservation(firestore, reservationId) {
  return firestore.collection('orders')
    .where('reservationId', '==', reservationId)
    .limit(1)
    .get()
}

export async function createRazorpayPaymentOrder({
  reservationId,
  cancellationToken,
  idempotencyKey,
}, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const configuration = getPaymentConfiguration({ keyId, publicKeyId, keySecret })
  const gateway = razorpay || createRazorpayClient(configuration)
  const tokenSnapshot = await firestore.collection('reservationTokens').doc(reservationId).get()
  if (
    !tokenSnapshot.exists
    || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)
  ) {
    throw paymentError('INVALID_RESERVATION_TOKEN', 'Reservation access could not be verified.')
  }

  const matchingOrder = await lookupOrderByReservation(firestore, reservationId)
  if (matchingOrder.empty) {
    throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
  }
  const applicationOrderRef = matchingOrder.docs[0].ref
  const attemptKey = idempotencyHash(idempotencyKey)
  const receipt = `payment-${attemptKey.slice(0, 32)}`
  const claim = await firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(applicationOrderRef)
    if (!orderSnapshot.exists) throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
    const order = orderSnapshot.data()
    assertReservationCanBePaid(order, now())
    if (order.paymentStatus === 'captured') {
      throw paymentError('RESERVATION_ALREADY_PAID', 'This reservation already has a captured payment.')
    }

    const paymentAttempts = getPaymentAttempts(order)
    const existingAttempt = paymentAttempts[attemptKey]
    if (existingAttempt) {
      if (existingAttempt.status === 'creating') {
        throw paymentError('PAYMENT_ORDER_IN_PROGRESS', 'This payment order is still being created. Retry shortly.')
      }
      if (!existingAttempt.razorpayOrderId) {
        throw paymentError('PAYMENT_ORDER_IN_PROGRESS', 'This payment attempt cannot be safely retried.')
      }
      return {
        existing: true,
        amount: existingAttempt.amount,
        currency: existingAttempt.currency,
        razorpayOrderId: existingAttempt.razorpayOrderId,
        receipt: existingAttempt.receipt,
      }
    }

    if (
      hasActivePaymentAttempt(paymentAttempts)
      || (isPaymentBlockingNewAttempt(order.paymentStatus) && Object.keys(paymentAttempts).length > 0)
      || order.paymentStatus === 'authorized'
      || order.paymentStatus === 'captured'
    ) {
      throw paymentError('PAYMENT_ALREADY_IN_PROGRESS', 'A payment attempt is already active for this reservation.')
    }
    if (Object.keys(paymentAttempts).length >= MAX_PAYMENT_ATTEMPTS) {
      throw paymentError('PAYMENT_ATTEMPT_LIMIT', 'This reservation has reached its payment attempt limit.')
    }

    const orderItems = getReservationItems(order)
    if (!orderItems.length || orderItems.some((item) => !item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      throw paymentError('RESERVATION_STOCK_MISMATCH', 'The reserved quantity is no longer available.')
    }
    const quantities = new Map()
    for (const item of orderItems) {
      quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity)
    }
    const productSnapshots = new Map(await Promise.all([...quantities.keys()].map(async (productId) => [
      productId,
      await transaction.get(firestore.collection('products').doc(productId)),
    ])))
    if ([...productSnapshots.values()].some((snapshot) => !snapshot.exists)) {
      throw paymentError('PRODUCT_NOT_FOUND', 'A reserved product could not be found.')
    }
    const productData = new Map([...productSnapshots].map(([id, snapshot]) => [id, snapshot.data()]))
    const pricedItems = orderItems.map((item) => {
      const product = productData.get(item.productId)
      if (product.currency && product.currency !== PAYMENT_CURRENCY) {
        throw paymentError('INVALID_CURRENCY', 'Only INR payments are supported.')
      }
      return { ...item, price: Number(product.price) }
    })
    if (hasReservationStock(order)) {
      for (const [productId, quantity] of quantities) {
        if (normalizeInventory(productData.get(productId)).reservedStock < quantity) {
          throw paymentError('RESERVATION_STOCK_MISMATCH', 'The reserved quantity is no longer available.')
        }
      }
    } else {
      const reservations = new Map()
      try {
        for (const [productId, quantity] of quantities) {
          reservations.set(productId, reserveInventory(productData.get(productId), quantity))
        }
      } catch {
        throw paymentError('RESERVATION_STOCK_MISMATCH', 'The reserved quantity is no longer available.')
      }
      for (const [productId, inventory] of reservations) {
        transaction.update(productSnapshots.get(productId).ref, inventory)
      }
    }
    const amount = calculateRazorpayItemsAmountPaise(pricedItems)
    const authoritativeItems = pricedItems.map((item) => {
      const product = productData.get(item.productId)
      return {
        ...item,
        productName: typeof product.name === 'string' ? product.name : item.productName,
        image: product.images?.[0]?.url || product.images?.[0] || item.image || '',
        lineSubtotal: item.price * item.quantity,
      }
    })
    const firstItem = authoritativeItems[0]
    const createdAt = timestamp.now()
    const attempt = {
      status: 'creating',
      amount,
      currency: PAYMENT_CURRENCY,
      receipt,
      createdAt,
    }
    transaction.update(applicationOrderRef, {
      orderType: 'online_order',
      paymentMethod: 'razorpay',
      paymentStatus: 'pending',
      paymentAmountPaise: amount,
      paymentCurrency: PAYMENT_CURRENCY,
      price: firstItem.price,
      productName: firstItem.productName,
      items: authoritativeItems,
      subtotal: amount / 100,
      totalAmount: amount / 100,
      paymentIdempotencyKeyHash: attemptKey,
      stockReserved: true,
      stockReleasedAt: null,
      paymentAttempts: { ...paymentAttempts, [attemptKey]: attempt },
      razorpayOrderIds: Array.isArray(order.razorpayOrderIds) ? order.razorpayOrderIds : [],
      razorpayReceipts: [...new Set([...(order.razorpayReceipts || []), receipt])],
      inventoryOwnershipStatus: 'held',
    })
    return { existing: false, amount, currency: PAYMENT_CURRENCY, receipt }
  })

  if (claim.existing) {
    return {
      keyId: configuration.publicKeyId,
      razorpayOrderId: claim.razorpayOrderId,
      amount: claim.amount,
      currency: claim.currency,
    }
  }

  let gatewayOrder
  try {
    gatewayOrder = await gateway.orders.create({
      amount: claim.amount,
      currency: claim.currency,
      receipt: claim.receipt,
    })
  } catch {
    throw paymentError('PAYMENT_PROVIDER_ERROR', 'Razorpay could not create the payment order. Contact support before retrying.')
  }

  if (
    typeof gatewayOrder?.id !== 'string'
    || !/^order_[A-Za-z0-9]+$/.test(gatewayOrder.id)
    || gatewayOrder.amount !== claim.amount
    || gatewayOrder.currency !== PAYMENT_CURRENCY
  ) {
    throw paymentError('PAYMENT_PROVIDER_ERROR', 'Razorpay returned an invalid payment order.')
  }

  await firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(applicationOrderRef)
    if (!orderSnapshot.exists) throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
    const order = orderSnapshot.data()
    const paymentAttempts = getPaymentAttempts(order)
    const attempt = paymentAttempts[attemptKey]
    if (!attempt || attempt.status !== 'creating') {
      throw paymentError('PAYMENT_ORDER_IN_PROGRESS', 'Payment order state changed unexpectedly.')
    }
    const updatedAttempt = {
      ...attempt,
      status: 'pending',
      razorpayOrderId: gatewayOrder.id,
    }
    transaction.update(applicationOrderRef, {
      razorpayOrderId: gatewayOrder.id,
      razorpayOrderIds: [...new Set([...(order.razorpayOrderIds || []), gatewayOrder.id])],
      paymentAttempts: { ...paymentAttempts, [attemptKey]: updatedAttempt },
    })
  })

  return {
    keyId: configuration.publicKeyId,
    razorpayOrderId: gatewayOrder.id,
    amount: claim.amount,
    currency: PAYMENT_CURRENCY,
  }
}

export async function verifyRazorpayPayment({
  razorpay_order_id: razorpayOrderId,
  razorpay_payment_id: razorpayPaymentId,
  razorpay_signature: razorpaySignature,
}, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const configuration = getPaymentConfiguration({ keyId, publicKeyId, keySecret })
  const gateway = razorpay || createRazorpayClient(configuration)
  if (!verifiedSignatureMatches(razorpayOrderId, razorpayPaymentId, razorpaySignature, configuration.keySecret)) {
    throw paymentError('INVALID_PAYMENT_SIGNATURE', 'Payment signature could not be verified.')
  }

  const matchingOrder = await firestore.collection('orders')
    .where('razorpayOrderIds', 'array-contains', razorpayOrderId)
    .limit(1)
    .get()
  if (matchingOrder.empty) {
    throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with a reservation.')
  }
  const applicationOrderRef = matchingOrder.docs[0].ref
  const storedOrder = matchingOrder.docs[0].data()
  const storedAttempt = findAttemptByOrderId(storedOrder, razorpayOrderId)
  if (!storedAttempt) {
    throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with a reservation.')
  }
  const [attemptKey, attempt] = storedAttempt
  if (attempt.currency !== PAYMENT_CURRENCY || !Number.isSafeInteger(attempt.amount) || attempt.amount <= 0) {
    throw paymentError('INVALID_PAYMENT_RECORD', 'Stored payment details are invalid.')
  }

  let gatewayPayment
  try {
    gatewayPayment = await gateway.payments.fetch(razorpayPaymentId)
  } catch {
    throw paymentError('PAYMENT_PROVIDER_ERROR', 'Razorpay payment details could not be retrieved.')
  }
  if (
    gatewayPayment?.id !== razorpayPaymentId
    || gatewayPayment.order_id !== razorpayOrderId
    || gatewayPayment.amount !== attempt.amount
    || gatewayPayment.currency !== PAYMENT_CURRENCY
  ) {
    throw paymentError('PAYMENT_DETAILS_MISMATCH', 'Razorpay payment details do not match the reservation.')
  }
  const paymentStatus = ['authorized', 'captured', 'failed'].includes(gatewayPayment.status)
    ? gatewayPayment.status
    : 'pending'

  return firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(applicationOrderRef)
    if (!orderSnapshot.exists) throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Payment order is no longer available.')
    const order = orderSnapshot.data()
    const paymentAttempts = getPaymentAttempts(order)
    const currentAttempt = paymentAttempts[attemptKey]
    if (!currentAttempt || currentAttempt.razorpayOrderId !== razorpayOrderId) {
      throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with a reservation.')
    }

    if (
      currentAttempt.paymentId === razorpayPaymentId
      && currentAttempt.status === paymentStatus
      && (
        paymentStatus !== 'captured'
        || hasReservationStock(order)
        || order.paymentReconciliationStatus === 'manual_review'
        || order.reservationStatus !== 'active'
      )
    ) {
      return { status: currentAttempt.status, duplicate: true }
    }
    if (currentAttempt.paymentId === razorpayPaymentId) {
      if (currentAttempt.status === 'captured' && paymentStatus !== 'captured') {
        return { status: 'captured', duplicate: true }
      }
      if (
        currentAttempt.status === 'failed'
        && paymentStatus !== 'failed'
        && !(paymentStatus === 'captured' && order.checkoutAbandoned === true)
      ) {
        throw paymentError('PAYMENT_ALREADY_PROCESSED', 'A failed payment cannot be changed to another status.')
      }
    }
    if (order.paymentStatus === 'captured' && order.razorpayPaymentId !== razorpayPaymentId) {
      throw paymentError('RESERVATION_ALREADY_PAID', 'This reservation already has a captured payment.')
    }
    if (
      currentAttempt.paymentId
      && currentAttempt.paymentId !== razorpayPaymentId
      && isPaymentBlockingNewAttempt(currentAttempt.status)
    ) {
      throw paymentError('PAYMENT_ALREADY_PROCESSED', 'A different payment has already been processed for this attempt.')
    }
    const reservationEligible = isReservationEligibleForPayment(order, now())
    const dismissedReservation = order.checkoutAbandoned === true
      && ['released', 'expired'].includes(order.reservationStatus)
    if (
      !reservationEligible
      && !dismissedReservation
      && !['authorized', 'captured'].includes(paymentStatus)
      && !(paymentStatus === 'failed' && order.checkoutAbandoned === true)
    ) {
      assertReservationCanBePaid(order, now())
    }
    if (
      !['authorized', 'captured'].includes(paymentStatus)
      && !(paymentStatus === 'failed' && order.checkoutAbandoned === true)
      && (order.stockRestored || order.orderStatus === 'cancelled' || order.orderStatus === 'completed')
    ) {
      throw paymentError('RESERVATION_NOT_PAYABLE', 'This reservation is no longer available for payment.')
    }

    const verifiedAt = timestamp.now()
    const updatedAttempt = {
      ...currentAttempt,
      status: paymentStatus,
      paymentId: razorpayPaymentId,
      verifiedAt,
    }
    const updatedAttempts = { ...paymentAttempts, [attemptKey]: updatedAttempt }
    const aggregateStatus = getAggregatePaymentStatus(order, updatedAttempts)
    const update = {
      paymentAttempts: updatedAttempts,
    }
    if (
      order.paymentIdempotencyKeyHash === attemptKey
      || paymentStatus === 'authorized'
      || paymentStatus === 'captured'
    ) {
      Object.assign(update, {
        paymentStatus: aggregateStatus,
        paymentCurrency: PAYMENT_CURRENCY,
        paymentAmountPaise: currentAttempt.amount,
        razorpayOrderId,
        razorpayPaymentId,
        paymentVerifiedAt: verifiedAt,
      })
    }
    if (
      ['authorized', 'captured'].includes(paymentStatus)
      && !reservationEligible
      && !dismissedReservation
    ) {
      Object.assign(update, {
        paymentReconciliationStatus: 'manual_review',
        paymentReconciliationReason: 'payment_after_reservation_expiry_or_release',
        ...(paymentStatus === 'captured' ? { refundRequired: true } : {}),
      })
    } else if (paymentStatus === 'captured') {
      const fulfillment = await fulfillCapturedReservationInTransaction(
        transaction,
        applicationOrderRef,
        order,
        { firestore, timestamp, now },
      )
      if (fulfillment.fulfilled) {
        Object.assign(update, fulfillment.orderPatch)
      } else {
        Object.assign(update, {
          paymentReconciliationStatus: 'manual_review',
          paymentReconciliationReason: fulfillment.reason === 'reservation_not_available'
            ? 'payment_after_reservation_expiry_or_release'
            : 'captured_payment_without_available_inventory',
          refundRequired: true,
        })
      }
    }
    const release = paymentStatus === 'failed'
      && shouldReleaseReservationStockAfterFailure(order, updatedAttempts, attemptKey, paymentStatus)
      ? await releaseReservationStockInTransaction(
        transaction,
        applicationOrderRef,
        order,
        { firestore, timestamp, reason: 'Razorpay payment failed' },
      )
      : null
    if (release) Object.assign(update, release.orderPatch)
    transaction.update(applicationOrderRef, update)
    if (paymentStatus === 'captured' && update.refundRequired === true) {
      return {
        status: paymentStatus,
        duplicate: false,
        refundRequired: true,
        reservationId: order.reservationId,
        paymentId: razorpayPaymentId,
        amount: currentAttempt.amount,
      }
    }
    return { status: paymentStatus, duplicate: false }
  })
}

export async function recordRazorpayPaymentFailure({
  reservationId,
  cancellationToken,
  razorpay_order_id: razorpayOrderId,
  razorpay_payment_id: razorpayPaymentId,
}, {
  firestore = db,
  timestamp = Timestamp,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const configuration = getPaymentConfiguration({ keyId, publicKeyId, keySecret })
  const gateway = razorpay || createRazorpayClient(configuration)
  const tokenSnapshot = await firestore.collection('reservationTokens').doc(reservationId).get()
  if (
    !tokenSnapshot.exists
    || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)
  ) {
    throw paymentError('INVALID_RESERVATION_TOKEN', 'Reservation access could not be verified.')
  }

  const matchingOrder = await lookupOrderByReservation(firestore, reservationId)
  if (matchingOrder.empty) {
    throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
  }
  const applicationOrderRef = matchingOrder.docs[0].ref
  const storedOrder = matchingOrder.docs[0].data()
  const storedAttempt = findAttemptByOrderId(storedOrder, razorpayOrderId)
  if (!storedAttempt) {
    throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with this reservation.')
  }
  const reconcile = () => reconcileRazorpayReservationPayment(reservationId, {
    firestore,
    timestamp,
    keyId,
    publicKeyId,
    keySecret,
    razorpay: gateway,
  })
  if (!razorpayPaymentId) {
    return reconcile()
  }
  const [attemptKey, attempt] = storedAttempt
  let gatewayPayment
  if (gateway.api?.rq?.defaults) {
    gateway.api.rq.defaults.timeout = PAYMENT_RECONCILIATION_TIMEOUT_MS
  }
  try {
    gatewayPayment = await gateway.payments.fetch(razorpayPaymentId)
  } catch {
    return reconcile()
  }
  if (
    gatewayPayment?.id !== razorpayPaymentId
    || gatewayPayment.order_id !== razorpayOrderId
    || gatewayPayment.amount !== attempt.amount
    || gatewayPayment.currency !== PAYMENT_CURRENCY
  ) {
    throw paymentError('PAYMENT_DETAILS_MISMATCH', 'Razorpay payment details do not match the reservation.')
  }
  if (gatewayPayment.status !== 'failed') {
    return reconcile()
  }

  return firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(applicationOrderRef)
    if (!orderSnapshot.exists) throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
    const order = orderSnapshot.data()
    const paymentAttempts = getPaymentAttempts(order)
    const currentAttempt = paymentAttempts[attemptKey]
    if (!currentAttempt || currentAttempt.razorpayOrderId !== razorpayOrderId) {
      throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with this reservation.')
    }
    if (currentAttempt.paymentId === razorpayPaymentId && currentAttempt.status === 'failed') {
      return { status: 'failed', duplicate: true }
    }
    if (currentAttempt.status === 'captured') {
      throw paymentError('PAYMENT_ALREADY_PROCESSED', 'This payment attempt has already been captured.')
    }

    const verifiedAt = timestamp.now()
    const updatedAttempt = {
      ...currentAttempt,
      status: 'failed',
      paymentId: razorpayPaymentId,
      verifiedAt,
    }
    const updatedAttempts = { ...paymentAttempts, [attemptKey]: updatedAttempt }
    const aggregateStatus = getAggregatePaymentStatus(order, updatedAttempts)
    const update = {
      paymentAttempts: updatedAttempts,
    }
    if (order.paymentIdempotencyKeyHash === attemptKey && order.paymentStatus !== 'captured') {
      Object.assign(update, {
        paymentStatus: aggregateStatus,
        paymentCurrency: PAYMENT_CURRENCY,
        paymentAmountPaise: currentAttempt.amount,
        razorpayOrderId,
        razorpayPaymentId,
        paymentVerifiedAt: verifiedAt,
      })
    }

    const release = shouldReleaseReservationStockAfterFailure(
      order,
      updatedAttempts,
      attemptKey,
      'failed',
    )
      ? await releaseReservationStockInTransaction(
        transaction,
        applicationOrderRef,
        order,
        { firestore, timestamp, reason: 'Razorpay payment failed' },
      )
      : null
    if (release) Object.assign(update, release.orderPatch)
    transaction.update(applicationOrderRef, update)
    return { status: 'failed', duplicate: false }
  })
}

export async function abandonRazorpayCheckout({
  reservationId,
  cancellationToken,
  razorpay_order_id: razorpayOrderId,
}, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const tokenSnapshot = await firestore.collection('reservationTokens').doc(reservationId).get()
  if (
    !tokenSnapshot.exists
    || !cancellationTokenMatches(cancellationToken, tokenSnapshot.data().tokenHash)
  ) {
    throw paymentError('INVALID_RESERVATION_TOKEN', 'Reservation access could not be verified.')
  }
  const matchingOrder = await lookupOrderByReservation(firestore, reservationId)
  if (matchingOrder.empty) throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
  const orderRef = matchingOrder.docs[0].ref
  const storedOrder = matchingOrder.docs[0].data()
  if (storedOrder.paymentMethod !== 'razorpay') {
    throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'This reservation has no Razorpay payment attempt.')
  }
  const storedAttempt = findAttemptByOrderId(storedOrder, razorpayOrderId)
  if (!storedAttempt) {
    throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with this reservation.')
  }

  let reconciliationError = null
  try {
    await reconcileRazorpayReservationPayment(reservationId, {
      firestore,
      timestamp,
      now,
      keyId,
      publicKeyId,
      keySecret,
      razorpay,
    })
  } catch (error) {
    if (error?.code !== 'PAYMENT_STATUS_UNAVAILABLE') throw error
    reconciliationError = error
  }

  let result
  try {
    result = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef)
      if (!snapshot.exists) throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
      const order = snapshot.data()
      const productSnapshot = await transaction.get(firestore.collection('products').doc(order.productId))
      const inventoryBefore = productSnapshot.exists ? normalizeInventory(productSnapshot.data()) : null
      const attempts = getPaymentAttempts(order)
      const [attemptKey, attempt] = findAttemptByOrderId(order, razorpayOrderId) || []
      if (!attempt || attemptKey !== storedAttempt[0]) {
        throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is no longer associated with this reservation.')
      }

      const dismissedAt = timestamp.now()
      const updatedAttempt = {
        ...attempt,
        checkoutDismissedAt: dismissedAt,
        checkoutStatus: 'dismissed',
        ...(reconciliationError ? { reconciliationStatus: 'unresolved' } : {}),
      }
      const updatedAttempts = { ...attempts, [attemptKey]: updatedAttempt }
      const aggregateStatus = getAggregatePaymentStatus(order, updatedAttempts)
      const paymentOutcome = reconciliationError && aggregateStatus === 'pending'
        ? 'unresolved'
        : aggregateStatus
      const hasCapturedPayment = aggregateStatus === 'captured'
      const hasAuthorizedPayment = aggregateStatus === 'authorized'
      const otherUnresolvedAttempt = Object.entries(updatedAttempts).some(([key, candidate]) => (
        key !== attemptKey && getEffectiveAttemptStatus(candidate) !== 'failed'
      ))
      const update = {
        paymentAttempts: updatedAttempts,
        checkoutDismissedAt: dismissedAt,
        checkoutStatus: 'dismissed',
        ...(reconciliationError ? {
          paymentReconciliationStatus: order.paymentReconciliationStatus === 'manual_review'
            ? 'manual_review'
            : 'pending',
          paymentReconciliationReason: 'payment_status_unavailable_after_checkout_dismissal',
        } : {}),
      }
      let releaseOperationResult = 'already_released'
      let inventoryAfter = inventoryBefore

      if (hasCapturedPayment || hasAuthorizedPayment) {
        const ownerStatus = hasReservationStock(order) ? 'held' : order.inventoryOwnershipStatus
        update.paymentStatus = aggregateStatus
        update.inventoryOwnershipStatus = ownerStatus
        transaction.update(orderRef, update)
        releaseOperationResult = hasCapturedPayment ? 'protected_captured' : 'protected_authorized'
        return {
          status: aggregateStatus,
          inventoryStatus: ownerStatus === 'held' ? 'held' : ownerStatus || 'consumed',
          paymentOutcome,
          releaseOperationResult,
          productId: order.productId,
          previousStockReserved: hasReservationStock(order),
          inventoryBefore,
          inventoryAfter,
        }
      }

      if (order.paymentStatus !== 'captured' && !otherUnresolvedAttempt) {
        const release = await releaseReservationStockInTransaction(
          transaction,
          orderRef,
          order,
          {
            firestore,
            timestamp,
            reason: 'Razorpay Checkout dismissed before capture',
            productSnapshot,
          },
        )
        Object.assign(update, release.orderPatch)
        update.reservationStatus = 'released'
        update.releasedAt = dismissedAt
        update.checkoutAbandoned = true
        update.inventoryOwnershipStatus = 'released'
        update.paymentStatus = aggregateStatus === 'failed' ? 'failed' : 'pending'
        if (aggregateStatus !== 'failed') {
          update.paymentReconciliationStatus = 'pending'
          update.paymentReconciliationReason = reconciliationError
            ? 'payment_status_unavailable_after_checkout_dismissal'
            : 'checkout_dismissed_payment_unresolved'
        }
        inventoryAfter = release.inventory || inventoryBefore
        releaseOperationResult = hasReservationStock(order) ? 'released' : 'already_released'
      } else if (otherUnresolvedAttempt) {
        releaseOperationResult = 'retained_other_unresolved_attempt'
      }
      transaction.update(orderRef, update)
      return {
        status: update.paymentStatus || aggregateStatus,
        inventoryStatus: hasReservationStock(order) && update.stockReserved !== false
          ? 'held'
          : 'released',
        paymentOutcome,
        releaseOperationResult,
        productId: order.productId,
        previousStockReserved: hasReservationStock(order),
        inventoryBefore,
        inventoryAfter,
      }
    })
  } catch (error) {
    console.error('[razorpay-checkout-dismissal] ' + JSON.stringify({
      reservationId,
      razorpayOrderId,
      productId: storedOrder.productId || null,
      paymentOutcome: reconciliationError ? 'unresolved' : getEffectiveAttemptStatus(storedAttempt[1]),
      previousStockReserved: hasReservationStock(storedOrder),
      releaseOperationResult: 'failed',
      reservedStockBefore: null,
      reservedStockAfter: null,
      availableStockBefore: null,
      availableStockAfter: null,
      errorCode: error?.code || 'UNKNOWN',
    }))
    throw error
  }

  console.info('[razorpay-checkout-dismissal] ' + JSON.stringify({
    reservationId,
    razorpayOrderId,
    productId: result.productId,
    paymentOutcome: result.paymentOutcome,
    previousStockReserved: result.previousStockReserved,
    releaseOperationResult: result.releaseOperationResult,
    reservedStockBefore: result.inventoryBefore?.reservedStock ?? null,
    reservedStockAfter: result.inventoryAfter?.reservedStock ?? null,
    availableStockBefore: result.inventoryBefore?.availableStock ?? null,
    availableStockAfter: result.inventoryAfter?.availableStock ?? null,
  }))
  return {
    status: result.status,
    inventoryStatus: result.inventoryStatus,
    paymentOutcome: result.paymentOutcome,
    releaseOperationResult: result.releaseOperationResult,
  }
}

function reconciliationUnavailable() {
  return paymentError(
    'PAYMENT_STATUS_UNAVAILABLE',
    'Razorpay payment status could not be verified. Reserved stock remains held; retry shortly.',
  )
}

async function fetchRazorpayAttemptStatus(gateway, razorpayOrderId, attempt) {
  if (!gateway.orders?.fetch || !gateway.orders?.fetchPayments) {
    throw reconciliationUnavailable()
  }
  if (gateway.api?.rq?.defaults) {
    gateway.api.rq.defaults.timeout = PAYMENT_RECONCILIATION_TIMEOUT_MS
  }

  let timeoutId
  try {
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => reject(reconciliationUnavailable()), PAYMENT_RECONCILIATION_TIMEOUT_MS)
    })
    const [providerOrder, providerPayments] = await Promise.race([
      Promise.all([
        gateway.orders.fetch(razorpayOrderId),
        gateway.orders.fetchPayments(razorpayOrderId),
      ]),
      timeout,
    ])
    if (
      providerOrder?.id !== razorpayOrderId
      || providerOrder.currency !== PAYMENT_CURRENCY
      || providerOrder.amount !== attempt.amount
      || !['created', 'attempted', 'paid'].includes(providerOrder.status)
      || !Number.isSafeInteger(providerOrder.attempts)
      || providerOrder.attempts < 0
      || !Array.isArray(providerPayments?.items)
      || (Number.isSafeInteger(providerPayments.count) && providerPayments.count < providerPayments.items.length)
    ) {
      throw reconciliationUnavailable()
    }

    for (const payment of providerPayments.items) {
      if (
        typeof payment?.id !== 'string'
        || !/^pay_[A-Za-z0-9]+$/.test(payment.id)
        || payment.order_id !== razorpayOrderId
        || payment.amount !== attempt.amount
        || payment.currency !== PAYMENT_CURRENCY
        || typeof payment.status !== 'string'
      ) {
        throw reconciliationUnavailable()
      }
    }

    const itemsComplete = providerOrder.attempts === providerPayments.items.length
      && (!Number.isSafeInteger(providerPayments.count)
        || providerPayments.count === providerPayments.items.length)
    const capturedPayment = providerPayments.items.find((payment) => payment.status === 'captured')
    if (providerOrder.status === 'paid') {
      if (providerOrder.amount_paid !== attempt.amount) throw reconciliationUnavailable()
      return { status: 'captured', payments: providerPayments.items, paymentId: capturedPayment?.id }
    }
    if (capturedPayment) {
      return { status: 'captured', payments: providerPayments.items, paymentId: capturedPayment.id }
    }
    if (providerPayments.items.some((payment) => payment.status === 'authorized')) {
      return { status: 'authorized', payments: providerPayments.items }
    }
    if (
      itemsComplete
      && providerPayments.items.length > 0
      && providerPayments.items.every((payment) => payment.status === 'failed')
    ) {
      return {
        status: 'failed',
        payments: providerPayments.items,
        paymentId: providerPayments.items[providerPayments.items.length - 1].id,
      }
    }
    return { status: 'pending', payments: providerPayments.items }
  } catch (error) {
    if (error?.code === 'PAYMENT_STATUS_UNAVAILABLE') throw error
    throw reconciliationUnavailable()
  } finally {
    clearTimeout(timeoutId)
  }
}

function nextReconciledAttemptStatus(currentStatus, incomingStatus) {
  if (currentStatus === 'captured' || incomingStatus === 'captured') return 'captured'
  if (currentStatus === 'authorized' && incomingStatus !== 'failed') return 'authorized'
  return incomingStatus
}

function nextReconciledPaymentStatus(currentStatus, incomingStatus) {
  if (currentStatus === 'captured' || incomingStatus === 'captured') return 'captured'
  return incomingStatus
}

function reservationHasExpired(order, now) {
  const expiresAt = order.expiresAt?.toMillis?.()
    ?? order.expiresAt?.toDate?.().getTime()
    ?? (order.expiresAt instanceof Date ? order.expiresAt.getTime() : Date.parse(order.expiresAt))
  return Number.isFinite(expiresAt) && expiresAt <= now
}

export async function reconcileRazorpayReservationPayment(reservationId, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const matchingOrder = await lookupOrderByReservation(firestore, reservationId)
  if (matchingOrder.empty) {
    throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
  }
  const applicationOrderRef = matchingOrder.docs[0].ref
  const storedOrder = matchingOrder.docs[0].data()
  if (storedOrder.paymentMethod !== 'razorpay') {
    return { status: storedOrder.paymentStatus || 'pending', reconciled: false }
  }

  const storedAttempts = getPaymentAttempts(storedOrder)
  const attemptEntries = Object.entries(storedAttempts)
  const storedStatus = getAggregatePaymentStatus(storedOrder, storedAttempts)
  const providerStates = new Map()

  if (storedStatus !== 'captured' && attemptEntries.some(([, attempt]) =>
    getEffectiveAttemptStatus(attempt) !== 'failed',
  )) {
    const unresolvedEntries = attemptEntries.filter(([, attempt]) =>
      getEffectiveAttemptStatus(attempt) !== 'failed',
    )
    const entriesWithOrderIds = unresolvedEntries.filter(([, attempt]) =>
      typeof attempt.razorpayOrderId === 'string' && /^order_[A-Za-z0-9]+$/.test(attempt.razorpayOrderId),
    )
    let gateway = razorpay
    if (entriesWithOrderIds.length > 0 && !gateway) {
      let configuration
      try {
        configuration = getPaymentConfiguration({ keyId, publicKeyId, keySecret })
      } catch {
        throw reconciliationUnavailable()
      }
      gateway = createRazorpayClient(configuration)
    }
    for (const [attemptKey, attempt] of unresolvedEntries) {
      if (typeof attempt.razorpayOrderId !== 'string' || !/^order_[A-Za-z0-9]+$/.test(attempt.razorpayOrderId)) {
        providerStates.set(attemptKey, { status: 'pending', payments: [] })
        continue
      }
      providerStates.set(
        attemptKey,
        await fetchRazorpayAttemptStatus(gateway, attempt.razorpayOrderId, attempt),
      )
    }
  }

  return firestore.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(applicationOrderRef)
    if (!orderSnapshot.exists) {
      throw paymentError('RESERVATION_NOT_FOUND', 'Reservation not found.')
    }
    const order = orderSnapshot.data()
    const paymentAttempts = getPaymentAttempts(order)
    const updatedAttempts = { ...paymentAttempts }
    let capturedPayment = null
    let authorizedPayment = null
    let latestFailedPayment = null

    for (const [attemptKey, attempt] of Object.entries(paymentAttempts)) {
      const providerState = providerStates.get(attemptKey)
      if (!providerState) {
        const effectiveStatus = getEffectiveAttemptStatus(attempt)
        if (effectiveStatus === 'captured') capturedPayment ||= { attemptKey, attempt }
        if (effectiveStatus === 'authorized') authorizedPayment ||= { attemptKey, attempt }
        if (effectiveStatus === 'failed') latestFailedPayment = { attemptKey, attempt }
        continue
      }

      const currentStatus = getEffectiveAttemptStatus(attempt)
      const attemptStatus = nextReconciledAttemptStatus(currentStatus, providerState.status)
      const existingPayments = attempt.payments && typeof attempt.payments === 'object'
        ? attempt.payments
        : {}
      const reconciledPayments = { ...existingPayments }
      for (const payment of providerState.payments) {
        reconciledPayments[payment.id] = {
          status: nextReconciledAttemptStatus(
            existingPayments[payment.id]?.status,
            payment.status,
          ),
        }
      }
      const paymentId = providerState.paymentId || attempt.paymentId
      const updatedAttempt = {
        ...attempt,
        status: attemptStatus,
        ...(paymentId ? { paymentId } : {}),
        ...(providerState.payments.length ? { payments: reconciledPayments } : {}),
        verifiedAt: timestamp.now(),
      }
      updatedAttempts[attemptKey] = updatedAttempt
      if (attemptStatus === 'captured') capturedPayment ||= { attemptKey, attempt: updatedAttempt }
      if (attemptStatus === 'authorized') authorizedPayment ||= { attemptKey, attempt: updatedAttempt }
      if (attemptStatus === 'failed') latestFailedPayment = { attemptKey, attempt: updatedAttempt }
    }

    const paymentStatus = getAggregatePaymentStatus(order, updatedAttempts)
    const update = {
      paymentAttempts: updatedAttempts,
      paymentStatus: nextReconciledPaymentStatus(order.paymentStatus, paymentStatus),
    }
    const finalStatus = update.paymentStatus
    const relevantPayment = capturedPayment || authorizedPayment || latestFailedPayment
    if (relevantPayment) {
      const [, attempt] = Object.entries(updatedAttempts)
        .find(([attemptKey]) => attemptKey === relevantPayment.attemptKey) || []
      if (attempt?.amount) update.paymentAmountPaise = attempt.amount
      update.paymentCurrency = attempt?.currency || PAYMENT_CURRENCY
      if (attempt?.razorpayOrderId) update.razorpayOrderId = attempt.razorpayOrderId
      if (attempt?.paymentId) update.razorpayPaymentId = attempt.paymentId
    }

    let release = null
    if (
      finalStatus === 'failed'
      && Object.keys(updatedAttempts).length > 0
      && Object.values(updatedAttempts).every((attempt) => getEffectiveAttemptStatus(attempt) === 'failed')
      && hasReservationStock(order)
    ) {
      release = await releaseReservationStockInTransaction(
        transaction,
        applicationOrderRef,
        order,
        { firestore, timestamp, reason: 'Razorpay payment failure verified during reservation reconciliation' },
      )
      Object.assign(update, release.orderPatch)
    }

    if (finalStatus === 'captured') {
      const reservationUnavailable = (order.reservationStatus === 'expired' && order.checkoutAbandoned !== true)
        || (order.reservationStatus === 'released' && order.checkoutAbandoned !== true)
        || (
          order.reservationStatus === 'active'
          && reservationHasExpired(order, now())
          && !hasReservationStock(order)
        )
        || order.stockRestored === true
      if (reservationUnavailable) {
        Object.assign(update, {
          paymentReconciliationStatus: 'manual_review',
          paymentReconciliationReason: 'payment_after_reservation_expiry_or_release',
          refundRequired: true,
        })
      } else {
        const fulfillment = await fulfillCapturedReservationInTransaction(
          transaction,
          applicationOrderRef,
          order,
          { firestore, timestamp, now },
        )
        if (fulfillment.fulfilled) {
          Object.assign(update, fulfillment.orderPatch)
        } else {
          Object.assign(update, {
            paymentReconciliationStatus: 'manual_review',
            paymentReconciliationReason: fulfillment.reason === 'reservation_not_available'
              ? 'payment_after_reservation_expiry_or_release'
              : 'captured_payment_without_available_inventory',
            refundRequired: true,
          })
        }

      }
    }
    transaction.update(applicationOrderRef, update)
    return {
      status: finalStatus,
      reconciled: providerStates.size > 0 || storedStatus === 'failed' || storedStatus === 'captured',
      stockReleased: Boolean(release?.inventory),
    }
  })
}

export async function processRazorpayRefund({
  reservationId,
  paymentId,
  amount,
  reason = 'Captured payment could not be fulfilled',
}, {
  firestore = db,
  timestamp = Timestamp,
  keyId,
  publicKeyId,
  keySecret,
  razorpay,
} = {}) {
  const configuration = getPaymentConfiguration({ keyId, publicKeyId, keySecret })
  const gateway = razorpay || createRazorpayClient(configuration)
  const matchingOrder = await firestore.collection('orders')
    .where('reservationId', '==', reservationId)
    .limit(1)
    .get()
  if (matchingOrder.empty) throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Reservation not found.')
  const orderRef = matchingOrder.docs[0].ref

  const claim = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef)
    if (!snapshot.exists) throw paymentError('PAYMENT_ORDER_NOT_FOUND', 'Reservation not found.')
    const order = snapshot.data()
    const resolvedPaymentId = paymentId || order.razorpayPaymentId
    if (!resolvedPaymentId || order.razorpayPaymentId !== resolvedPaymentId || order.paymentStatus !== 'captured') {
      throw paymentError('PAYMENT_DETAILS_MISMATCH', 'The refund payment is not a captured payment for this reservation.')
    }
    if (order.refundStatus === 'processed') {
      return { duplicate: true, refundId: order.refundId || null, processed: true, paymentId: resolvedPaymentId }
    }
    const verifiedAmount = Number.isSafeInteger(amount) && amount > 0
      ? amount
      : order.paymentAmountPaise
    if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount <= 0) {
      throw paymentError('INVALID_AMOUNT', 'Refund amount is invalid.')
    }
    if (order.refundStatus === 'pending' && order.refundId) {
      return { duplicate: true, refundId: order.refundId, processed: false, paymentId: resolvedPaymentId }
    }
    const requestedAt = timestamp.now()
    transaction.update(orderRef, {
      refundRequired: true,
      refundStatus: 'requested',
      refundAmountPaise: verifiedAmount,
      refundReason: reason,
      refundRequestedAt: requestedAt,
      refundLastAttemptAt: requestedAt,
    })
    return { duplicate: false, refundId: null, processed: false, amount: verifiedAmount, paymentId: resolvedPaymentId }
  })

  if (claim.duplicate) {
    if (claim.refundId && typeof gateway.refunds?.fetch === 'function') {
      try {
        const providerRefund = await gateway.refunds.fetch(claim.refundId)
        if (providerRefund.status === 'processed') {
          await firestore.runTransaction(async (transaction) => {
            transaction.update(orderRef, {
              refundStatus: 'processed',
              refundProcessedAt: timestamp.now(),
            })
          })
          return { status: 'processed', refundId: claim.refundId }
        }
      } catch {
        // Keep failed or pending refunds visible for safe later retry.
      }
    }
    return { status: claim.processed ? 'processed' : 'pending', refundId: claim.refundId }
  }

  try {
    if (typeof gateway.refunds?.create !== 'function') {
      throw paymentError('REFUND_PROVIDER_ERROR', 'Refund API is unavailable.')
    }
    const providerRefund = await gateway.refunds.create({
      payment_id: claim.paymentId,
      amount: claim.amount,
    })
    if (
      typeof providerRefund?.id !== 'string'
      || providerRefund.payment_id !== claim.paymentId
      || providerRefund.amount !== claim.amount
    ) {
      throw paymentError('REFUND_DETAILS_MISMATCH', 'Razorpay returned an invalid refund.')
    }
    const status = providerRefund.status === 'processed' ? 'processed' : 'pending'
    await firestore.runTransaction(async (transaction) => {
      transaction.update(orderRef, {
        refundId: providerRefund.id,
        refundStatus: status,
        refundPaymentId: claim.paymentId,
        refundAmountPaise: providerRefund.amount,
        refundProviderStatus: providerRefund.status,
        ...(status === 'processed' ? { refundProcessedAt: timestamp.now() } : {}),
      })
    })
    return { status, refundId: providerRefund.id }
  } catch (error) {
    await firestore.runTransaction(async (transaction) => {
      transaction.update(orderRef, {
        refundStatus: 'failed',
        refundFailedAt: timestamp.now(),
        refundErrorCode: error?.code || 'REFUND_PROVIDER_ERROR',
        refundError: error?.message || 'Razorpay refund request failed.',
      })
    })
    throw error?.code ? error : paymentError('REFUND_PROVIDER_ERROR', 'Razorpay refund request failed.')
  }
}

export const razorpayPaymentInternals = {
  getPaymentConfiguration,
  verifiedSignatureMatches,
  findAttemptByOrderId,
  findAttemptByReceipt,
  getAggregatePaymentStatus,
  shouldReleaseReservationStockAfterFailure,
}
