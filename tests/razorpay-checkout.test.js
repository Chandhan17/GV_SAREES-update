import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkoutReservation,
  isConfirmedCheckoutResult,
  openRazorpayCheckout,
} from '../src/services/razorpayService.js'

const item = {
  id: 'product-1',
  quantity: 2,
  sizeLength: '5.5 m',
  reservationKey: 'cart-reservation-key-001',
}
const customer = {
  name: 'Test Customer',
  phone: '9876543210',
}
const reservation = {
  reservationId: 'reservation-1',
  cancellationToken: 'a'.repeat(64),
}
const order = {
  keyId: 'rzp_test_example',
  razorpayOrderId: 'order_test123',
  amount: 5150,
  currency: 'INR',
}
const payment = {
  razorpay_order_id: order.razorpayOrderId,
  razorpay_payment_id: 'pay_test123',
  razorpay_signature: 'signed-payment-data',
}

test('Razorpay modal dismissal callback resolves checkout as cancelled', async (t) => {
  const originalWindow = globalThis.window
  let checkoutOptions
  globalThis.window = {
    Razorpay: class {
      constructor(options) {
        checkoutOptions = options
      }

      on() {}

      open() {
        checkoutOptions.modal.ondismiss()
      }
    },
  }
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  })

  const result = await openRazorpayCheckout({ order, customer, productName: 'Test saree' })
  assert.equal(typeof checkoutOptions.modal.ondismiss, 'function')
  assert.deepEqual(result, { type: 'cancelled' })
})

test('Razorpay success returns payment details without opening a WhatsApp popup', async (t) => {
  const originalWindow = globalThis.window
  let checkoutOptions
  let popupCalls = 0
  globalThis.window = {
    open() {
      popupCalls += 1
    },
    Razorpay: class {
      constructor(options) {
        checkoutOptions = options
      }

      on() {}

      open() {
        checkoutOptions.handler(payment)
        checkoutOptions.handler(payment)
      }
    },
  }
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  })

  const result = await openRazorpayCheckout({
    order,
    customer,
    productName: 'Test saree',
  })

  assert.deepEqual(result, { type: 'success', payment })
  assert.equal(popupCalls, 0)
})

test('Razorpay payment failure does not open a WhatsApp popup', async (t) => {
  const originalWindow = globalThis.window
  let failureHandler
  let popupCalls = 0
  globalThis.window = {
    open() {
      popupCalls += 1
    },
    Razorpay: class {
      constructor() {}

      on(event, callback) {
        if (event === 'payment.failed') failureHandler = callback
      }

      open() {
        failureHandler({ error: { metadata: { payment_id: 'pay_failed' } } })
      }
    },
  }
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  })

  const result = await openRazorpayCheckout({
    order,
    customer,
    productName: 'Test saree',
  })

  assert.equal(result.type, 'failed')
  assert.equal(popupCalls, 0)
})

function createDependencies(overrides = {}) {
  const calls = {
    reservations: [],
    remembered: [],
    orderRequests: [],
    verification: [],
    failures: [],
    dismissals: [],
    checkout: [],
    statuses: [],
  }
  const dependencies = {
    loadScript: async () => true,
    createReservation: async (input) => {
      calls.reservations.push(input)
      return reservation
    },
    rememberReservation: (...args) => calls.remembered.push(args),
    getCheckoutKey: () => 'payment-attempt-key-001',
    createCheckoutKey: () => 'payment-attempt-key-002',
    getStatus: async () => {
      const status = calls.statuses.length ? calls.statuses.shift() : { paymentStatus: 'pending' }
      return status
    },
    createOrder: async (input) => {
      calls.orderRequests.push(input)
      return order
    },
    openCheckout: async (input) => {
      calls.checkout.push(input)
      return { type: 'success', payment }
    },
    verifyPayment: async (input) => {
      calls.verification.push(input)
      return { status: 'captured' }
    },
    reportFailure: async (input) => {
      calls.failures.push(input)
      return { status: 'failed' }
    },
    reportDismissal: async (input) => {
      calls.dismissals.push(input)
      return { status: 'pending', inventoryStatus: 'held' }
    },
    ...overrides,
  }
  return { dependencies, calls }
}

test('checkout creates a reservation and requests a server-priced INR order', async () => {
  const { dependencies, calls } = createDependencies()
  calls.statuses.push(
    { paymentStatus: 'pending' },
    { paymentStatus: 'captured' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'captured')
  assert.deepEqual(calls.reservations[0], {
    productId: item.id,
    quantity: item.quantity,
    idempotencyKey: item.reservationKey,
    selectedSize: item.sizeLength,
    customer,
  })
  assert.deepEqual(calls.orderRequests[0], {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    idempotencyKey: 'payment-attempt-key-001',
  })
  assert.equal('amount' in calls.orderRequests[0], false)
  assert.equal(calls.checkout[0].order, order)
  assert.deepEqual(calls.verification, [payment])
  assert.deepEqual(calls.remembered[1], [reservation, 'payment-attempt-key-001'])
})

test('multi-item cart uses one reservation and one Razorpay payment order', async () => {
  const secondItem = {
    id: 'product-2',
    quantity: 1,
    sizeLength: '6.3 m',
    reservationKey: 'cart-reservation-key-002',
  }
  const { dependencies, calls } = createDependencies()
  calls.statuses.push(
    { paymentStatus: 'pending' },
    {
      paymentStatus: 'captured',
      orderStatus: 'confirmed',
      orderId: 'reservation-order-1',
      paymentId: payment.razorpay_payment_id,
      items: [
        { productId: item.id, productName: 'Floral Dola Silk Fancy Saree', quantity: 2, price: 2499 },
        { productId: secondItem.id, productName: 'Mangalagiri Handloom Cotton Saree', quantity: 1, price: 2899 },
      ],
      paymentAmountPaise: 789700,
    },
  )

  const result = await checkoutReservation({
    items: [item, secondItem],
    customer,
    productName: 'Floral Dola Silk Fancy Saree, Mangalagiri Handloom Cotton Saree',
  }, dependencies)

  assert.equal(calls.reservations.length, 1)
  assert.deepEqual(calls.reservations[0].items, [
    { productId: item.id, quantity: item.quantity, selectedSize: item.sizeLength },
    { productId: secondItem.id, quantity: secondItem.quantity, selectedSize: secondItem.sizeLength },
  ])
  assert.equal(calls.orderRequests.length, 1)
  assert.equal(calls.checkout.length, 1)
  assert.equal(result.status, 'captured')
  assert.equal(result.orderStatus, 'confirmed')
  assert.equal(result.items.length, 2)
  assert.equal(result.paymentAmountPaise, 789700)
})

test('verified checkout only returns confirmed server data after payment verification', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async (input) => {
      calls.checkout.push(input)
      return { type: 'success', payment }
    },
    verifyPayment: async (input) => {
      calls.verification.push(input)
      return { status: 'captured', orderStatus: 'confirmed' }
    },
  })
  const sequence = []
  dependencies.verifyPayment = async (input) => {
    sequence.push('verify')
    calls.verification.push(input)
    return { status: 'captured', orderStatus: 'confirmed' }
  }
  dependencies.getStatus = async () => {
    sequence.push('status')
    return calls.statuses.length ? calls.statuses.shift() : { paymentStatus: 'pending' }
  }
  calls.statuses.push(
    { paymentStatus: 'pending' },
    {
      paymentStatus: 'captured',
      orderStatus: 'confirmed',
      orderId: 'reservation-order-1',
      paymentId: payment.razorpay_payment_id,
    },
  )

  const result = await checkoutReservation(
    { item, customer, productName: 'Test saree' },
    dependencies,
  )

  assert.deepEqual(sequence, ['status', 'verify', 'status'])
  assert.equal(result.status, 'captured')
  assert.equal(result.orderStatus, 'confirmed')
  assert.equal('whatsappWindow' in result, false)
})

test('server-verified status, not the checkout callback, determines the displayed payment state', async () => {
  const { dependencies, calls } = createDependencies()
  calls.statuses.push(
    { paymentStatus: 'pending' },
    { paymentStatus: 'authorized' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(calls.verification.length, 1)
  assert.equal(result.status, 'authorized')
  assert.equal(result.checkoutStatus, 'verified')
})

test('only captured and fulfilled server status qualifies as confirmed checkout', () => {
  const confirmed = {
    status: 'captured',
    orderStatus: 'confirmed',
    orderId: 'reservation-order-1',
    paymentId: 'pay_mock1',
  }

  assert.equal(isConfirmedCheckoutResult(confirmed), true)
  for (const result of [
    { ...confirmed, status: 'pending' },
    { ...confirmed, status: 'authorized' },
    { ...confirmed, status: 'failed' },
    { ...confirmed, orderStatus: 'initiated' },
    { ...confirmed, orderStatus: 'processing' },
    { ...confirmed, orderId: '' },
    { ...confirmed, paymentId: '' },
    { ...confirmed, orderId: '   ' },
    { ...confirmed, paymentId: '   ' },
    { status: 'captured', orderStatus: 'confirmed' },
  ]) {
    assert.equal(isConfirmedCheckoutResult(result), false)
  }
})

test('failed payments are reported to the backend and a retry gets a new idempotency key', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => ({
      type: 'failed',
      orderId: order.razorpayOrderId,
      paymentId: payment.razorpay_payment_id,
    }),
  })
  calls.statuses.push(
    { paymentStatus: 'failed' },
    { paymentStatus: 'failed' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'failed')
  assert.equal(result.checkoutStatus, 'failed')
  assert.deepEqual(calls.failures[0], {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
    razorpay_payment_id: payment.razorpay_payment_id,
  })
  assert.equal(calls.orderRequests[0].idempotencyKey, 'payment-attempt-key-002')
  assert.equal(calls.verification.length, 0)
})

test('checkout failure without a payment ID still requests server reconciliation', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => ({
      type: 'failed',
      orderId: order.razorpayOrderId,
    }),
  })
  calls.statuses.push(
    { paymentStatus: 'pending', inventoryStatus: 'held' },
    { paymentStatus: 'failed', inventoryStatus: 'released' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'failed')
  assert.equal(result.inventoryStatus, 'released')
  assert.deepEqual(calls.failures[0], {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
  })
})

test('checkout network error reconciles through dismissal without assuming payment failure', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => {
      throw new Error('Checkout network error')
    },
    reportDismissal: async (input) => {
      calls.dismissals.push(input)
      return { status: 'captured', inventoryStatus: 'held' }
    },
  })
  calls.statuses.push(
    { paymentStatus: 'pending' },
    { paymentStatus: 'captured', inventoryStatus: 'held' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'captured')
  assert.equal(result.checkoutStatus, 'cancelled')
  assert.deepEqual(calls.dismissals[0], {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
  })
  assert.equal(calls.failures.length, 0)
})

test('dismissed checkout retains unresolved inventory through the backend without marking payment failed', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => ({ type: 'cancelled' }),
  })

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'pending')
  assert.equal(result.checkoutStatus, 'cancelled')
  assert.equal(calls.verification.length, 0)
  assert.equal(calls.failures.length, 0)
  assert.equal(calls.dismissals.length, 1)
  assert.deepEqual(calls.dismissals[0], {
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    razorpay_order_id: order.razorpayOrderId,
  })
  assert.equal(result.inventoryStatus, 'held')
})

test('retry after checkout dismissal reuses the same reservation and payment attempt', async () => {
  let savedCheckoutKey = ''
  let nextCheckoutKey = 0
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => ({ type: 'cancelled' }),
    createReservation: async (input) => {
      calls.reservations.push(input)
      return reservation
    },
    rememberReservation: (...args) => {
      calls.remembered.push(args)
      savedCheckoutKey = args[1] || savedCheckoutKey
    },
    getCheckoutKey: () => savedCheckoutKey,
    createCheckoutKey: () => `payment-attempt-key-${++nextCheckoutKey}`,
  })

  await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)
  await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(calls.reservations.length, 2)
  assert.equal(calls.orderRequests[0].reservationId, calls.orderRequests[1].reservationId)
  assert.equal(calls.orderRequests.length, 2)
  assert.equal(calls.orderRequests[0].idempotencyKey, calls.orderRequests[1].idempotencyKey)
  assert.equal(calls.dismissals.length, 2)
  assert.equal(calls.failures.length, 0)
})

test('captured or authorized state reported during dismissal is retained', async () => {
  for (const paymentStatus of ['captured', 'authorized']) {
    const statuses = [
      { paymentStatus: 'pending', inventoryStatus: 'held' },
      { paymentStatus, inventoryStatus: 'held' },
    ]
    const { dependencies } = createDependencies({
      reportDismissal: async () => ({ status: paymentStatus, inventoryStatus: 'held' }),
      getStatus: async () => statuses.shift(),
      openCheckout: async () => ({ type: 'cancelled' }),
    })
    const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)
    assert.equal(result.status, paymentStatus)
    assert.equal(result.inventoryStatus, 'held')
  }
})

test('checkout open network errors use dismissal reconciliation', async () => {
  const { dependencies, calls } = createDependencies({
    openCheckout: async () => {
      throw new Error('Checkout network error')
    },
  })
  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)
  assert.equal(result.checkoutStatus, 'cancelled')
  assert.equal(result.inventoryStatus, 'held')
  assert.equal(calls.dismissals.length, 1)
  assert.equal(calls.failures.length, 0)
})

test('checkout reports a failed dismissal request instead of implying stock was released', async () => {
  const { dependencies } = createDependencies({
    openCheckout: async () => ({ type: 'cancelled' }),
    reportDismissal: async () => {
      throw new Error('Dismissal API returned 503.')
    },
  })

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.checkoutStatus, 'cancelled')
  assert.equal(result.dismissalReconciled, false)
  assert.equal(result.dismissalError, 'Dismissal API returned 503.')
})

test('checkout retries a transient dismissal failure with the same idempotent request', async () => {
  let calls = 0
  const { dependencies } = createDependencies({
    openCheckout: async () => ({ type: 'cancelled' }),
    reportDismissal: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('Temporary service failure.'), { status: 503 })
      return { status: 'pending', inventoryStatus: 'held' }
    },
  })

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(calls, 2)
  assert.equal(result.dismissalReconciled, true)
  assert.equal(result.inventoryStatus, 'held')
})

test('checkout uses the successful dismissal response when the follow-up status read fails', async () => {
  let statusReads = 0
  const { dependencies } = createDependencies({
    openCheckout: async () => ({ type: 'cancelled' }),
    getStatus: async () => {
      statusReads += 1
      if (statusReads > 1) throw new Error('Status API unavailable.')
      return { paymentStatus: 'pending', inventoryStatus: 'held' }
    },
    reportDismissal: async () => ({ status: 'pending', inventoryStatus: 'held' }),
  })

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.dismissalReconciled, true)
  assert.equal(result.inventoryStatus, 'held')
})

test('captured webhook status after checkout is reflected from the status API', async () => {
  const { dependencies, calls } = createDependencies()
  calls.statuses.push(
    { paymentStatus: 'pending' },
    { paymentStatus: 'captured' },
  )

  const result = await checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)

  assert.equal(result.status, 'captured')
  assert.equal(calls.statuses.length, 0)
})

test('a concurrent duplicate submission for the same cart line cannot start a second reservation', async () => {
  let releaseScript
  const scriptGate = new Promise((resolve) => {
    releaseScript = resolve
  })
  const { dependencies, calls } = createDependencies({
    loadScript: () => scriptGate,
  })

  const firstCheckout = checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies)
  await assert.rejects(
    checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies),
    /already in progress/,
  )
  releaseScript(true)
  await firstCheckout

  assert.equal(calls.reservations.length, 1)
})

test('checkout refuses live-mode or malformed server order data', async () => {
  const { dependencies, calls } = createDependencies({
    createOrder: async () => ({ ...order, keyId: 'rzp_live_example' }),
  })

  await assert.rejects(
    checkoutReservation({ item, customer, productName: 'Test saree' }, dependencies),
    /invalid Razorpay order details/,
  )
  assert.equal(calls.checkout.length, 0)
  assert.equal(calls.verification.length, 0)
})
