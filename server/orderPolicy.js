const ORDER_STATUSES = new Set([
  'initiated',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'completed',
])

const NEXT_FULFILLMENT_STATUS = {
  confirmed: 'processing',
  processing: 'shipped',
  shipped: 'delivered',
}

const UNRESOLVED_PAYMENT_STATUSES = new Set([
  'creating',
  'created',
  'pending',
  'authorized',
  'processing',
  'capturing',
])

const TERMINAL_PAYMENT_ATTEMPT_STATUSES = new Set(['failed', 'captured'])
const RESOLVED_ISSUE_STATUSES = new Set([
  'cancelled',
  'closed',
  'completed',
  'none',
  'rejected',
  'resolved',
  'won',
  'lost',
])

export function validateOrderStatusTransition(order, nextStatus) {
  if (!ORDER_STATUSES.has(nextStatus)) {
    throw Object.assign(new Error('Unsupported order status.'), { code: 'INVALID_ORDER_STATUS' })
  }

  const currentStatus = order.orderStatus || 'initiated'
  if (currentStatus === nextStatus) return

  if (nextStatus === 'confirmed') {
    throw Object.assign(new Error('Paid orders are confirmed automatically after verified payment.'), {
      code: 'AUTOMATIC_CONFIRMATION_REQUIRED',
    })
  }

  if (nextStatus === 'cancelled') {
    if (order.paymentMethod === 'razorpay' && order.paymentStatus === 'captured' && order.refundStatus !== 'processed') {
      throw Object.assign(new Error('A captured payment must be fully refunded before this order can be cancelled.'), {
        code: 'PAYMENT_REQUIRES_REFUND',
      })
    }
    return
  }

  if (nextStatus === 'initiated') {
    throw Object.assign(new Error('Orders cannot be reopened.'), { code: 'INVALID_ORDER_TRANSITION' })
  }

  if (
    order.paymentMethod === 'razorpay'
    && order.paymentStatus !== 'captured'
  ) {
    throw Object.assign(new Error('Order fulfillment requires verified captured payment.'), {
      code: 'PAYMENT_NOT_CAPTURED',
    })
  }

  const expectedNext = NEXT_FULFILLMENT_STATUS[currentStatus]
  const legacyCompleted = nextStatus === 'completed' && currentStatus === 'confirmed'
  if (nextStatus !== expectedNext && !legacyCompleted) {
    throw Object.assign(new Error('Invalid order status transition.'), { code: 'INVALID_ORDER_TRANSITION' })
  }

  if (order.stockRestored || currentStatus === 'cancelled') {
    throw Object.assign(new Error('Cancelled or restocked orders cannot be fulfilled.'), { code: 'INVALID_ORDER_TRANSITION' })
  }
}

export function assertOrderCanArchive(order) {
  if (order.reservationStatus === 'active') {
    throw Object.assign(new Error('Release or resolve the active inventory hold before archiving this order.'), { code: 'ACTIVE_RESERVATION' })
  }
}

export function assertOrderCanDelete(order) {
  if (order.reservationStatus === 'active' || order.stockReserved === true) {
    throw Object.assign(new Error('Orders with an active inventory hold cannot be deleted.'), { code: 'ACTIVE_RESERVATION' })
  }

  if (order.paymentReconciliationStatus === 'manual_review') {
    throw Object.assign(new Error('Resolve payment reconciliation before deleting this order.'), { code: 'PAYMENT_UNRESOLVED' })
  }

  const paymentStatus = order.paymentStatus
  if (!['captured', 'paid', 'failed', 'refunded'].includes(paymentStatus)) {
    throw Object.assign(new Error('Only orders with a terminal payment status can be deleted.'), { code: 'PAYMENT_UNRESOLVED' })
  }

  const unsettledAttempt = Object.values(order.paymentAttempts || {}).some((attempt) =>
    UNRESOLVED_PAYMENT_STATUSES.has(attempt?.status)
    || Object.values(attempt?.payments || {}).some((payment) =>
      UNRESOLVED_PAYMENT_STATUSES.has(payment?.status),
    ),
  )
  if (unsettledAttempt) {
    throw Object.assign(new Error('Resolve all pending payment attempts before deleting this order.'), { code: 'PAYMENT_UNRESOLVED' })
  }

  const refundStatus = order.refundStatus
  if (
    (order.refundRequired === true && refundStatus !== 'processed')
    || (refundStatus && !['processed', 'none'].includes(refundStatus))
    || (paymentStatus === 'refunded' && refundStatus !== 'processed')
  ) {
    throw Object.assign(new Error('Resolve the refund before deleting this order.'), { code: 'REFUND_UNRESOLVED' })
  }

  const isCapturedPayment = ['captured', 'paid'].includes(paymentStatus)
  if (isCapturedPayment && !['delivered', 'completed', 'cancelled'].includes(order.orderStatus)) {
    throw Object.assign(new Error('Complete or cancel fulfillment before deleting this paid order.'), { code: 'ORDER_NOT_TERMINAL' })
  }

  if (
    isCapturedPayment
    && order.orderStatus === 'cancelled'
    && refundStatus !== 'processed'
  ) {
    throw Object.assign(new Error('A cancelled paid order must have a processed refund before deletion.'), { code: 'REFUND_UNRESOLVED' })
  }
}

export function assertOrderCanPermanentlyDelete(order) {
  assertOrderCanDelete(order)

  if (order.paymentReconciliationStatus) {
    throw Object.assign(new Error('Resolve payment reconciliation before permanently deleting this order.'), {
      code: 'PAYMENT_UNRESOLVED',
    })
  }

  const paymentAttempts = order.paymentAttempts && typeof order.paymentAttempts === 'object'
    && !Array.isArray(order.paymentAttempts)
    ? Object.values(order.paymentAttempts)
    : []
  let capturedAttemptFound = false
  for (const attempt of paymentAttempts) {
    if (!attempt || !TERMINAL_PAYMENT_ATTEMPT_STATUSES.has(attempt.status)) {
      throw Object.assign(new Error('Resolve every Razorpay payment attempt before permanently deleting this order.'), {
        code: 'PAYMENT_UNRESOLVED',
      })
    }

    const payments = attempt.payments && typeof attempt.payments === 'object' && !Array.isArray(attempt.payments)
      ? Object.values(attempt.payments)
      : []
    if (payments.some((payment) => !payment || !TERMINAL_PAYMENT_ATTEMPT_STATUSES.has(payment.status))) {
      throw Object.assign(new Error('Resolve every nested Razorpay payment before permanently deleting this order.'), {
        code: 'PAYMENT_UNRESOLVED',
      })
    }
    if (attempt.status === 'captured' || payments.some((payment) => payment.status === 'captured')) {
      capturedAttemptFound = true
    }
  }

  if (capturedAttemptFound && !['captured', 'paid', 'refunded'].includes(order.paymentStatus)) {
    throw Object.assign(new Error('Payment attempts conflict with the order payment status; reconcile before deletion.'), {
      code: 'PAYMENT_UNRESOLVED',
    })
  }

  if (
    order.paymentMethod === 'razorpay'
    && ['captured', 'paid'].includes(order.paymentStatus)
    && !order.razorpayPaymentId
    && !capturedAttemptFound
  ) {
    throw Object.assign(new Error('The captured Razorpay payment has no verified payment reference.'), {
      code: 'PAYMENT_UNRESOLVED',
    })
  }

  if (
    order.paymentMethod === 'razorpay'
    && order.paymentStatus === 'failed'
    && paymentAttempts.length === 0
  ) {
    throw Object.assign(new Error('The failed Razorpay payment has no terminal attempt record to verify.'), {
      code: 'PAYMENT_UNRESOLVED',
    })
  }

  if (
    order.refundReconciliationStatus
    && !RESOLVED_ISSUE_STATUSES.has(order.refundReconciliationStatus)
  ) {
    throw Object.assign(new Error('Resolve refund reconciliation before permanently deleting this order.'), {
      code: 'REFUND_UNRESOLVED',
    })
  }

  const ownershipStatus = order.inventoryOwnershipStatus
  if (ownershipStatus && !['consumed', 'released'].includes(ownershipStatus)) {
    throw Object.assign(new Error('Inventory release or reconciliation is still pending for this order.'), {
      code: 'ACTIVE_RESERVATION',
    })
  }
  if (order.reservationStatus === 'converted' && order.stockDeducted !== true) {
    throw Object.assign(new Error('Converted inventory has not been fully reconciled.'), {
      code: 'ACTIVE_RESERVATION',
    })
  }

  for (const field of ['disputeStatus', 'chargebackStatus', 'returnStatus', 'replacementStatus', 'customerIssueStatus']) {
    const status = order[field]
    if (status && !RESOLVED_ISSUE_STATUSES.has(status)) {
      throw Object.assign(new Error(`Resolve the order's ${field.replace(/Status$/, '').toLowerCase()} before permanent deletion.`), {
        code: 'ORDER_ISSUE_UNRESOLVED',
      })
    }
  }

  for (const field of ['disputeOpen', 'chargebackOpen', 'returnOpen', 'replacementOpen', 'customerIssueOpen']) {
    if (order[field] === true) {
      throw Object.assign(new Error('Resolve open disputes, returns, replacements, or customer issues before permanent deletion.'), {
        code: 'ORDER_ISSUE_UNRESOLVED',
      })
    }
  }

  const fullRefundRequired = order.refundRequired === true
    || order.paymentStatus === 'refunded'
    || (['captured', 'paid'].includes(order.paymentStatus) && order.orderStatus === 'cancelled')
  if (fullRefundRequired && order.refundStatus === 'processed') {
    if (
      !Number.isSafeInteger(order.paymentAmountPaise)
      || !Number.isSafeInteger(order.refundAmountPaise)
      || order.paymentAmountPaise !== order.refundAmountPaise
    ) {
      throw Object.assign(new Error('The processed refund cannot be verified as full and reconciled.'), {
        code: 'REFUND_UNRESOLVED',
      })
    }
  }

  if (
    order.paymentStatus === 'refunded'
    && !['cancelled', 'delivered', 'completed'].includes(order.orderStatus)
  ) {
    throw Object.assign(new Error('Complete or cancel fulfillment before deleting a refunded order.'), {
      code: 'ORDER_NOT_TERMINAL',
    })
  }
}
