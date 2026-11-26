import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'
import { hasReservationStock } from './inventory.js'
import {
  createRazorpayTestClient,
  getRazorpayPaymentConfiguration,
  razorpayPaymentInternals,
} from './razorpayPaymentService.js'
import {
  fulfillCapturedReservationInTransaction,
  releaseReservationStockInTransaction,
} from './reservationService.js'

const db = getFirestore()
const PAYMENT_CURRENCY = 'INR'
const PROVIDER_ORDER_FETCH_TIMEOUT_MS = 8_000
const APPLICATION_RECEIPT_PATTERN = /^payment-[a-f0-9]{32}$/
const SUPPORTED_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
])

function webhookError(code, message) {
  return Object.assign(new Error(message), { code })
}

async function awaitStage(onStage, stage, operation) {
  onStage?.(`${stage}:start`)
  try {
    const result = await operation()
    onStage?.(`${stage}:complete`)
    return result
  } catch (error) {
    onStage?.(`${stage}:error`)
    throw error
  }
}

async function fetchProviderOrder(gateway, orderId, timeoutMs) {
  const axiosClient = gateway.api?.rq
  if (axiosClient?.defaults) {
    axiosClient.defaults.timeout = timeoutMs
  }

  let timeoutId
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(webhookError('PAYMENT_PROVIDER_TIMEOUT', 'Razorpay order reconciliation timed out.'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      gateway.orders.fetch(orderId).catch((error) => {
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
          throw webhookError('PAYMENT_PROVIDER_TIMEOUT', 'Razorpay order reconciliation timed out.')
        }
        throw error
      }),
      timeout,
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

export function verifyRazorpayWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const received = Buffer.from(signature, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function isExpired(order, now) {
  const expiresAt = order.expiresAt?.toMillis?.()
    ?? order.expiresAt?.toDate?.().getTime()
    ?? (order.expiresAt instanceof Date ? order.expiresAt.getTime() : Date.parse(order.expiresAt))
  return Number.isFinite(expiresAt) && expiresAt <= now
}

function getPaymentAttempts(order) {
  return order.paymentAttempts && typeof order.paymentAttempts === 'object'
    ? order.paymentAttempts
    : {}
}

function getEventPayment(event, payload) {
  if (event === 'order.paid') {
    const order = payload.order?.entity
    const payment = payload.payment?.entity
    if (
      !order
      || typeof order.id !== 'string'
      || !/^order_[A-Za-z0-9]+$/.test(order.id)
      || order.status !== 'paid'
      || !Number.isSafeInteger(order.amount_paid)
      || order.amount_paid <= 0
      || order.currency !== PAYMENT_CURRENCY
      || typeof order.receipt !== 'string'
    ) {
      throw webhookError('INVALID_WEBHOOK_EVENT', 'The Razorpay order.paid payload is invalid.')
    }
    if (
      payment
      && (
        typeof payment.id !== 'string'
        || !/^pay_[A-Za-z0-9]+$/.test(payment.id)
        || payment.order_id !== order.id
        || payment.amount !== order.amount_paid
        || payment.currency !== PAYMENT_CURRENCY
        || payment.status !== 'captured'
      )
    ) {
      throw webhookError('INVALID_WEBHOOK_EVENT', 'The Razorpay order.paid payment details are invalid.')
    }
    return {
      orderId: order.id,
      receipt: order.receipt,
      amount: order.amount_paid,
      currency: order.currency,
      status: 'captured',
      paymentId: payment?.id || null,
    }
  }

  const payment = payload.payment?.entity
  const eventStatus = {
    'payment.authorized': 'authorized',
    'payment.captured': 'captured',
    'payment.failed': 'failed',
  }[event]
  if (
    !payment
    || typeof payment.id !== 'string'
    || !/^pay_[A-Za-z0-9]+$/.test(payment.id)
    || typeof payment.order_id !== 'string'
    || !/^order_[A-Za-z0-9]+$/.test(payment.order_id)
    || !Number.isSafeInteger(payment.amount)
    || payment.amount <= 0
    || payment.currency !== PAYMENT_CURRENCY
    || payment.status !== eventStatus
  ) {
    throw webhookError('INVALID_WEBHOOK_EVENT', 'The Razorpay payment event payload is invalid.')
  }
  return {
    orderId: payment.order_id,
    receipt: null,
    amount: payment.amount,
    currency: payment.currency,
    status: eventStatus,
    paymentId: payment.id,
  }
}

async function findOrderByArrayValue(firestore, field, value, onStage, stage) {
  const result = await awaitStage(onStage, stage, () => firestore.collection('orders')
    .where(field, 'array-contains', value)
    .limit(1)
    .get())
  return result.empty ? null : result.docs[0]
}

async function recordIgnoredEvent(firestore, eventRef, eventId, event, timestamp, onStage) {
  return awaitStage(onStage, 'firestore_transaction', () => firestore.runTransaction(async (transaction) => {
    const currentEvent = await transaction.get(eventRef)
    if (currentEvent.exists) {
      return { duplicate: true, outcome: currentEvent.data().outcome }
    }
    transaction.create(eventRef, {
      eventId,
      event,
      outcome: 'ignored',
      processedAt: timestamp.now(),
    })
    return { duplicate: false, outcome: 'ignored' }
  }))
}

async function resolveApplicationOrder(firestore, gateway, eventPayment, onStage, providerTimeoutMs) {
  let orderDocument = await findOrderByArrayValue(
    firestore,
    'razorpayOrderIds',
    eventPayment.orderId,
    onStage,
    'application_order_lookup',
  )
  let providerOrder = null
  let receipt = eventPayment.receipt

  if (!orderDocument) {
    try {
      providerOrder = await awaitStage(
        onStage,
        'razorpay_reconciliation',
        () => fetchProviderOrder(gateway, eventPayment.orderId, providerTimeoutMs),
      )
    } catch (error) {
      if (error?.code === 'PAYMENT_PROVIDER_TIMEOUT') throw error
      throw webhookError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order could not be reconciled.')
    }
    if (
      providerOrder?.id !== eventPayment.orderId
      || providerOrder.currency !== PAYMENT_CURRENCY
      || !Number.isSafeInteger(providerOrder.amount)
      || providerOrder.amount <= 0
    ) {
      throw webhookError('INVALID_PROVIDER_ORDER', 'Razorpay returned an invalid order during reconciliation.')
    }
    if (
      receipt
      && receipt !== providerOrder.receipt
      && APPLICATION_RECEIPT_PATTERN.test(receipt)
    ) {
      throw webhookError('PAYMENT_ORDER_MISMATCH', 'Razorpay order receipt does not match the webhook payload.')
    }
    receipt = providerOrder.receipt
    if (typeof receipt !== 'string' || !APPLICATION_RECEIPT_PATTERN.test(receipt)) {
      return { ignored: true }
    }
    orderDocument = await findOrderByArrayValue(
      firestore,
      'razorpayReceipts',
      receipt,
      onStage,
      'receipt_lookup',
    )
    if (!orderDocument) return { ignored: true }
  }

  if (!orderDocument) {
    throw webhookError('PAYMENT_ORDER_NOT_FOUND', 'Razorpay order is not associated with a reservation.')
  }

  let order = orderDocument.data()
  let attempt = razorpayPaymentInternals.findAttemptByOrderId(order, eventPayment.orderId)
  if (!attempt && receipt) attempt = razorpayPaymentInternals.findAttemptByReceipt(order, receipt)
  if (!attempt) {
    return { ignored: true }
  }
  if (
    attempt[1].amount !== eventPayment.amount
    || attempt[1].currency !== eventPayment.currency
    || (receipt && attempt[1].receipt !== receipt)
    || (providerOrder && providerOrder.amount !== attempt[1].amount)
  ) {
    throw webhookError('PAYMENT_DETAILS_MISMATCH', 'Razorpay order amount or currency does not match the reservation.')
  }
  return { orderDocument, attemptKey: attempt[0], receipt, providerOrder, order }
}

function nextAttemptStatus(currentStatus, incomingStatus, samePaymentStatus) {
  if (incomingStatus === 'captured' || currentStatus === 'captured' || samePaymentStatus === 'captured') return 'captured'
  if (samePaymentStatus === 'failed' && incomingStatus === 'failed') return 'failed'
  if (samePaymentStatus === 'failed' && incomingStatus !== 'failed') return 'failed'
  return incomingStatus
}

function eventDocumentId(eventId) {
  return createHash('sha256').update(eventId).digest('hex')
}

export async function processRazorpayWebhookEvent({
  eventId,
  event,
  payload,
}, {
  firestore = db,
  timestamp = Timestamp,
  now = Date.now,
  razorpay,
  keyId,
  publicKeyId,
  keySecret,
  onStage,
  providerTimeoutMs = PROVIDER_ORDER_FETCH_TIMEOUT_MS,
} = {}) {
  const eventRef = firestore.collection('razorpayWebhookEvents').doc(eventDocumentId(eventId))
  const priorEvent = await awaitStage(onStage, 'event_idempotency_lookup', () => eventRef.get())
  if (priorEvent.exists) return { duplicate: true, outcome: priorEvent.data().outcome }

  if (!SUPPORTED_EVENTS.has(event)) {
    return recordIgnoredEvent(firestore, eventRef, eventId, event, timestamp, onStage)
  }

  const configuration = getRazorpayPaymentConfiguration({ keyId, publicKeyId, keySecret })
  const gateway = razorpay || createRazorpayTestClient(configuration)
  const eventPayment = getEventPayment(event, payload)
  const resolved = await resolveApplicationOrder(firestore, gateway, eventPayment, onStage, providerTimeoutMs)
  if (resolved.ignored) {
    return recordIgnoredEvent(firestore, eventRef, eventId, event, timestamp, onStage)
  }
  const orderRef = resolved.orderDocument.ref
  const { attemptKey } = resolved

  return awaitStage(onStage, 'firestore_transaction', () => firestore.runTransaction(async (transaction) => {
    const [eventSnapshot, orderSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(orderRef),
    ])
    if (eventSnapshot.exists) {
      return { duplicate: true, outcome: eventSnapshot.data().outcome }
    }
    if (!orderSnapshot.exists) {
      throw webhookError('PAYMENT_ORDER_NOT_FOUND', 'Application order disappeared during webhook processing.')
    }

    const order = orderSnapshot.data()
    const attempts = getPaymentAttempts(order)
    const attempt = attempts[attemptKey]
    if (!attempt || attempt.amount !== eventPayment.amount || attempt.currency !== PAYMENT_CURRENCY) {
      throw webhookError('PAYMENT_DETAILS_MISMATCH', 'Stored payment attempt does not match the webhook.')
    }
    if (attempt.razorpayOrderId && attempt.razorpayOrderId !== eventPayment.orderId) {
      throw webhookError('PAYMENT_ORDER_MISMATCH', 'Razorpay order ID does not match the stored payment attempt.')
    }

    const payments = attempt.payments && typeof attempt.payments === 'object' ? attempt.payments : {}
    const samePaymentStatus = eventPayment.paymentId
      ? payments[eventPayment.paymentId]?.status
      : undefined
    const attemptStatus = nextAttemptStatus(attempt.status, eventPayment.status, samePaymentStatus)
    const updatedAttempt = {
      ...attempt,
      status: attemptStatus,
      razorpayOrderId: eventPayment.orderId,
      ...(eventPayment.paymentId ? { paymentId: eventPayment.paymentId } : {}),
      ...(eventPayment.paymentId ? {
        payments: {
          ...payments,
          [eventPayment.paymentId]: {
            status: nextAttemptStatus(
              payments[eventPayment.paymentId]?.status || 'pending',
              eventPayment.status,
              samePaymentStatus,
            ),
          },
        },
      } : {}),
      verifiedAt: timestamp.now(),
    }

    const reservationExpired = (order.reservationStatus === 'expired' && order.checkoutAbandoned !== true)
      || (order.reservationStatus === 'released' && order.checkoutAbandoned !== true)
      || (
        order.reservationStatus === 'active'
        && isExpired(order, now())
        && !hasReservationStock(order)
      )
      || order.stockRestored === true
    let reviewRequired = reservationExpired && ['authorized', 'captured'].includes(attemptStatus)
    let reviewReason = reviewRequired ? 'payment_after_reservation_expiry_or_release' : ''
    const currentAttempt = order.paymentIdempotencyKeyHash === attemptKey
    const updatedAttempts = { ...attempts, [attemptKey]: updatedAttempt }
    const aggregatePaymentStatus = razorpayPaymentInternals.getAggregatePaymentStatus(order, updatedAttempts)
    const update = {
      paymentAttempts: updatedAttempts,
      razorpayOrderIds: [...new Set([...(order.razorpayOrderIds || []), eventPayment.orderId])],
      ...(resolved.receipt ? {
        razorpayReceipts: [...new Set([...(order.razorpayReceipts || []), resolved.receipt])],
      } : {}),
      ...(currentAttempt || eventPayment.status === 'captured' || eventPayment.status === 'authorized'
        ? { razorpayOrderId: eventPayment.orderId }
        : {}),
      ...(eventPayment.status === 'captured' || eventPayment.status === 'authorized'
        ? {
          paymentIdempotencyKeyHash: attemptKey,
          paymentCurrency: PAYMENT_CURRENCY,
          paymentAmountPaise: attempt.amount,
          paymentStatus: aggregatePaymentStatus,
          ...(eventPayment.paymentId ? { razorpayPaymentId: eventPayment.paymentId } : {}),
        }
        : {}),
      ...(eventPayment.status === 'failed'
        && currentAttempt
        && order.paymentStatus !== 'captured'
        ? {
          razorpayOrderId: eventPayment.orderId,
          paymentCurrency: PAYMENT_CURRENCY,
          paymentAmountPaise: attempt.amount,
          paymentStatus: aggregatePaymentStatus,
          ...(eventPayment.paymentId ? { razorpayPaymentId: eventPayment.paymentId } : {}),
        }
        : {}),
    }
    if (eventPayment.status === 'captured' && !reservationExpired && !order.stockDeducted) {
      const fulfillment = await fulfillCapturedReservationInTransaction(
        transaction,
        orderRef,
        order,
        { firestore, timestamp, now },
      )
      if (fulfillment.fulfilled) {
        Object.assign(update, fulfillment.orderPatch)
      } else {
        reviewRequired = true
        reviewReason = 'captured_payment_without_available_inventory'
        Object.assign(update, {
          refundRequired: true,
        })
      }
    } else if (eventPayment.status === 'captured' && reservationExpired) {
      update.refundRequired = true
    }
    if (reviewRequired) {
      Object.assign(update, {
        paymentReconciliationStatus: 'manual_review',
        paymentReconciliationReason: reviewReason,
      })
    }
    const release = eventPayment.status === 'failed'
      && razorpayPaymentInternals.shouldReleaseReservationStockAfterFailure(
        order,
        updatedAttempts,
        attemptKey,
        attemptStatus,
      )
      ? await releaseReservationStockInTransaction(
        transaction,
        orderRef,
        order,
        { firestore, timestamp, reason: 'Razorpay payment failed' },
      )
      : null
    if (release) Object.assign(update, release.orderPatch)
    transaction.update(orderRef, update)
    const outcome = reviewRequired ? 'manual_review' : attemptStatus
    transaction.create(eventRef, {
      eventId,
      event,
      razorpayOrderId: eventPayment.orderId,
      ...(eventPayment.paymentId ? { razorpayPaymentId: eventPayment.paymentId } : {}),
      outcome,
      processedAt: timestamp.now(),
    })
    if (update.refundRequired) {
      return {
        duplicate: false,
        outcome,
        refundRequired: true,
        reservationId: order.reservationId,
        paymentId: eventPayment.paymentId,
        amount: eventPayment.amount,
      }
    }
    return { duplicate: false, outcome }
  }))
}

export function getRazorpayWebhookSecret() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw webhookError('WEBHOOK_NOT_CONFIGURED', 'Razorpay webhook secret is not configured.')
  }
  return secret
}
