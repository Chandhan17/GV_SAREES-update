const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'
const checkoutKeysInProgress = new Set()

let razorpayScriptPromise = null

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function loadRazorpayScript() {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (window.Razorpay) return Promise.resolve(true)
  if (razorpayScriptPromise) return razorpayScriptPromise

  razorpayScriptPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = RAZORPAY_SCRIPT_URL
    script.async = true
    script.onload = () => resolve(true)
    script.onerror = () => {
      razorpayScriptPromise = null
      resolve(false)
    }
    document.body.appendChild(script)
  })

  return razorpayScriptPromise
}

async function postRazorpayRequest(path, payload, fallbackMessage) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(body.message || fallbackMessage), { status: response.status })
  }
  return body
}

export async function createRazorpayOrder({ reservationId, cancellationToken, idempotencyKey }) {
  return postRazorpayRequest(
    '/api/razorpay/create-order',
    { reservationId, cancellationToken, idempotencyKey },
    'Unable to create Razorpay order.',
  )
}

export async function verifyRazorpayPayment(payment) {
  return postRazorpayRequest(
    '/api/razorpay/verify',
    payment,
    'Unable to verify Razorpay payment.',
  )
}

export async function recordRazorpayPaymentFailure({
  reservationId,
  cancellationToken,
  razorpay_order_id,
  razorpay_payment_id,
}) {
  return postRazorpayRequest('/api/razorpay/verify', {
    reservationId,
    cancellationToken,
    razorpay_order_id,
    razorpay_payment_id,
  }, 'Unable to confirm Razorpay payment failure.')
}

export async function reportRazorpayCheckoutDismissal({
  reservationId,
  cancellationToken,
  razorpay_order_id,
}) {
  return postRazorpayRequest('/api/razorpay/verify', {
    action: 'checkout-dismissed',
    reservationId,
    cancellationToken,
    razorpay_order_id,
  }, 'Unable to reconcile the dismissed Razorpay Checkout.')
}

export function openRazorpayCheckout({ order, customer, productName }) {
  if (typeof window === 'undefined' || !window.Razorpay) {
    return Promise.reject(new Error('Razorpay Checkout is unavailable. Please try again.'))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const options = {
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: 'GV Sarees',
      description: productName,
      order_id: order.razorpayOrderId,
      prefill: {
        name: customer.name,
        contact: customer.phone,
      },
      handler: (response) => {
        if (settled) return
        finish({ type: 'success', payment: response })
      },
      modal: {
        ondismiss: () => finish({ type: 'cancelled' }),
      },
    }

    try {
      const checkout = new window.Razorpay(options)
      checkout.on('payment.failed', (failure) => {
        const metadata = failure?.error?.metadata || {}
        finish({
          type: 'failed',
          orderId: metadata.order_id || failure?.payment?.order_id || order.razorpayOrderId,
          paymentId: metadata.payment_id || failure?.payment?.id || '',
        })
      })
      checkout.open()
    } catch (error) {
      settled = true
      reject(error)
    }
  })
}

const isValidPaymentOrder = (order) => (
  typeof order?.keyId === 'string'
  && order.keyId.startsWith('rzp_test_')
  && typeof order.razorpayOrderId === 'string'
  && /^order_[A-Za-z0-9]+$/.test(order.razorpayOrderId)
  && Number.isSafeInteger(order.amount)
  && order.amount > 0
  && order.currency === 'INR'
)

export function isConfirmedCheckoutResult(result) {
  const hasIdentifier = (value) => typeof value === 'string' && value.trim().length > 0

  return result?.status === 'captured'
    && result?.orderStatus === 'confirmed'
    && hasIdentifier(result?.orderId)
    && hasIdentifier(result?.paymentId)
}

export async function checkoutReservation({
  items,
  item,
  customer,
  productName,
}, dependencies = {}) {
  const loadScript = dependencies.loadScript || loadRazorpayScript
  const createReservation = dependencies.createReservation
  const rememberReservation = dependencies.rememberReservation
  const getCheckoutKey = dependencies.getCheckoutKey
  const createCheckoutKey = dependencies.createCheckoutKey || createIdempotencyKey
  const getStatus = dependencies.getStatus
  const createOrder = dependencies.createOrder || createRazorpayOrder
  const openCheckout = dependencies.openCheckout || openRazorpayCheckout
  const verifyPayment = dependencies.verifyPayment || verifyRazorpayPayment
  const reportFailure = dependencies.reportFailure || recordRazorpayPaymentFailure
  const reportDismissal = dependencies.reportDismissal || reportRazorpayCheckoutDismissal
  const checkoutItems = Array.isArray(items) ? items : [item]
  const lockKey = checkoutItems[0]?.reservationKey

  if (!lockKey || checkoutKeysInProgress.has(lockKey)) {
    throw new Error('Checkout is already in progress for this cart.')
  }
  checkoutKeysInProgress.add(lockKey)

  try {
    if (!await loadScript()) {
      throw new Error('Razorpay Checkout could not be loaded. No reservation was created.')
    }
    if (!createReservation || !rememberReservation || !getStatus) {
      throw new Error('Reservation checkout is not configured.')
    }

    const reservation = await createReservation({
      ...(Array.isArray(items)
        ? {
          items: checkoutItems.map((checkoutItem) => ({
            productId: checkoutItem.id,
            quantity: checkoutItem.quantity,
            selectedSize: checkoutItem.sizeLength || '',
          })),
        }
        : {
          productId: item.id,
          quantity: item.quantity,
          selectedSize: item.sizeLength || '',
        }),
      idempotencyKey: lockKey,
      customer,
    })
    rememberReservation(reservation)

    const existingStatus = await getStatus(reservation.reservationId, reservation.cancellationToken)
    if (existingStatus.paymentStatus === 'captured') {
      return {
        status: 'captured',
        reservation,
        alreadyPaid: true,
        orderId: existingStatus.orderId,
        orderStatus: existingStatus.orderStatus,
        paymentId: existingStatus.paymentId,
        unitPrice: existingStatus.price,
        productName: existingStatus.productName,
        quantity: existingStatus.reservedQuantity,
        items: existingStatus.items || reservation.items || [],
        totalAmount: existingStatus.totalAmount,
        paymentAmountPaise: existingStatus.paymentAmountPaise,
      }
    }
    if (existingStatus.paymentStatus === 'authorized') {
      return { status: 'authorized', checkoutStatus: 'pending', reservation }
    }

    const idempotencyKey = existingStatus.paymentStatus === 'failed'
      ? createCheckoutKey()
      : getCheckoutKey?.(reservation.reservationId) || createCheckoutKey()
    rememberReservation(reservation, idempotencyKey)

    const order = await createOrder({
      reservationId: reservation.reservationId,
      cancellationToken: reservation.cancellationToken,
      idempotencyKey,
    })
    if (!isValidPaymentOrder(order)) {
      throw new Error('The server returned invalid Razorpay order details.')
    }

    const reconcileCheckoutAttempt = async (paymentId) => {
      const reported = await reportFailure({
        reservationId: reservation.reservationId,
        cancellationToken: reservation.cancellationToken,
        razorpay_order_id: order.razorpayOrderId,
        ...(paymentId ? { razorpay_payment_id: paymentId } : {}),
      })
      const status = await getStatus(reservation.reservationId, reservation.cancellationToken)
      const paymentStatus = status.paymentStatus || reported.status
      return {
        status: paymentStatus,
        checkoutStatus: paymentStatus === 'failed'
          ? 'failed'
          : paymentStatus === 'captured'
            ? 'verified'
            : 'pending',
        inventoryStatus: status.inventoryStatus,
        reservation,
        orderId: status.orderId,
        orderStatus: status.orderStatus,
        paymentId: status.paymentId,
        unitPrice: status.price,
        productName: status.productName,
        quantity: status.reservedQuantity,
        items: status.items || reservation.items || [],
        totalAmount: status.totalAmount,
        paymentAmountPaise: status.paymentAmountPaise,
      }
    }
    const reconcileDismissedCheckout = async () => {
      let dismissed
      let dismissalError
      try {
        dismissed = await reportDismissal({
          reservationId: reservation.reservationId,
          cancellationToken: reservation.cancellationToken,
          razorpay_order_id: order.razorpayOrderId,
        })
      } catch (error) {
        if (!Number.isInteger(error?.status) || error.status >= 500) {
          try {
            dismissed = await reportDismissal({
              reservationId: reservation.reservationId,
              cancellationToken: reservation.cancellationToken,
              razorpay_order_id: order.razorpayOrderId,
            })
          } catch (retryError) {
            dismissalError = retryError
          }
        } else {
          dismissalError = error
        }
      }
      if (dismissalError) {
        const status = await getStatus(reservation.reservationId, reservation.cancellationToken).catch(() => null)
        return {
          status: status?.paymentStatus || 'pending',
          checkoutStatus: 'cancelled',
          inventoryStatus: status?.inventoryStatus || 'unknown',
          reservation,
          orderId: status?.orderId,
          orderStatus: status?.orderStatus,
          paymentId: status?.paymentId,
          unitPrice: status?.price,
          productName: status?.productName,
          quantity: status?.reservedQuantity,
          items: status?.items || reservation.items || [],
          totalAmount: status?.totalAmount,
          paymentAmountPaise: status?.paymentAmountPaise,
          dismissalReconciled: false,
          dismissalError: dismissalError instanceof Error
            ? dismissalError.message
            : 'The server did not confirm inventory release.',
        }
      }
      const status = await getStatus(reservation.reservationId, reservation.cancellationToken).catch(() => null)
      const paymentStatus = status?.paymentStatus || dismissed.status || 'pending'
      return {
        status: paymentStatus,
        checkoutStatus: 'cancelled',
        inventoryStatus: status?.inventoryStatus || dismissed.inventoryStatus,
        reservation,
        orderId: status?.orderId,
        orderStatus: status?.orderStatus,
        paymentId: status?.paymentId,
        unitPrice: status?.price,
        productName: status?.productName,
        quantity: status?.reservedQuantity,
        items: status?.items || reservation.items || [],
        totalAmount: status?.totalAmount,
        paymentAmountPaise: status?.paymentAmountPaise,
        dismissalReconciled: true,
      }
    }

    let checkoutResult
    try {
      checkoutResult = await openCheckout({ order, customer, productName })
    } catch {
      return reconcileDismissedCheckout()
    }
    if (checkoutResult.type === 'cancelled') {
      return reconcileDismissedCheckout()
    }
    if (checkoutResult.type === 'failed') {
      return reconcileCheckoutAttempt(checkoutResult.paymentId)
    }
    if (checkoutResult.type !== 'success') {
      throw new Error('Razorpay Checkout returned an unrecognized result.')
    }

    let verification
    try {
      verification = await verifyPayment(checkoutResult.payment)
    } catch {
      return reconcileCheckoutAttempt(
        checkoutResult.payment?.razorpay_payment_id,
      )
    }
    const status = await getStatus(reservation.reservationId, reservation.cancellationToken)
    return {
      status: status.paymentStatus || verification.status,
      checkoutStatus: 'verified',
      reservation,
      orderId: status.orderId || verification.orderId,
      orderStatus: status.orderStatus || verification.orderStatus,
      paymentId: status.paymentId || verification.paymentId || checkoutResult.payment.razorpay_payment_id,
      unitPrice: status.price,
      productName: status.productName,
      quantity: status.reservedQuantity,
      items: status.items || reservation.items || [],
      totalAmount: status.totalAmount,
      paymentAmountPaise: status.paymentAmountPaise,
    }
  } finally {
    checkoutKeysInProgress.delete(lockKey)
  }
}
