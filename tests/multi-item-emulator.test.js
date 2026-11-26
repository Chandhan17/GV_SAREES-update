import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID } from 'node:crypto'
import process from 'node:process'
import test from 'node:test'

const enabled = process.env.RUN_MULTI_ITEM_EMULATOR_TEST === '1'

test('multi-item checkout retries a failed payment and reconciles capture by signed webhook', { skip: !enabled }, async () => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
  assert.ok(emulatorHost, 'FIRESTORE_EMULATOR_HOST must point to a local Firestore Emulator.')
  assert.ok(
    emulatorHost.startsWith('127.0.0.1:') || emulatorHost.startsWith('localhost:'),
    'This integration test may only write to a local Firestore Emulator.',
  )

  process.env.FIREBASE_PROJECT_ID = 'demo-gv-sarees'
  process.env.GCLOUD_PROJECT = 'demo-gv-sarees'
  const { initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  initializeApp({ projectId: 'demo-gv-sarees' })
  const firestore = getFirestore()
  const { createCheckoutReservation } = await import('../server/reservationService.js')
  const { createRazorpayPaymentOrder, verifyRazorpayPayment } = await import('../server/razorpayPaymentService.js')
  const { processRazorpayWebhookEvent } = await import('../server/razorpayWebhookService.js')
  const { default: webhookHandler } = await import('../api/razorpay/webhook.js')

  const suffix = randomUUID()
  const firstProductId = `emulator-floral-${suffix}`
  const secondProductId = `emulator-mangalagiri-${suffix}`
  const reservationRequestKey = `emulator-multi-${suffix}`
  const normalizedSuffix = suffix.replace(/-/g, '')
  const reservationItems = [
    { productId: firstProductId, quantity: 1, selectedSize: '5.5 m' },
    { productId: secondProductId, quantity: 1, selectedSize: '6.3 m' },
  ]
  const failedPaymentId = `pay_emulatorfailed${normalizedSuffix}`
  const capturedPaymentId = `pay_emulatorcaptured${normalizedSuffix}`
  const capturedEventId = `evt-captured-${normalizedSuffix}`
  const delayedFailureEventId = `evt-delayed-failure-${normalizedSuffix}`
  const webhookEventIds = [capturedEventId, delayedFailureEventId]
  const keyId = 'rzp_test_emulator_only'
  const keySecret = 'emulator-only-test-signing-secret'
  const webhookSecret = 'emulator-only-webhook-secret-long-enough'
  let reservation

  try {
    await firestore.collection('products').doc(firstProductId).set({
      name: 'Floral Dola Silk Fancy Saree',
      price: 2499,
      images: [],
      totalStock: 1,
      reservedStock: 0,
      availableStock: 1,
      inStock: true,
    })
    await firestore.collection('products').doc(secondProductId).set({
      name: 'Mangalagiri Handloom Cotton Saree',
      price: 2899,
      images: [],
      totalStock: 1,
      reservedStock: 0,
      availableStock: 1,
      inStock: true,
    })

    reservation = await createCheckoutReservation({
      items: reservationItems,
      customer: { name: 'Emulator Test', phone: '9876543210', address: 'Test address' },
      idempotencyKey: reservationRequestKey,
    }, {
      firestore,
      cancellationSecret: 'emulator-reservation-secret-long-enough',
    })
    assert.equal(reservation.totalAmount, 5398)
    assert.equal((await firestore.collection('products').doc(firstProductId).get()).data().reservedStock, 1)
    assert.equal((await firestore.collection('products').doc(secondProductId).get()).data().reservedStock, 1)

    const createdProviderOrders = []
    const providerPayments = new Map()
    const gateway = {
      orders: {
        async create(payload) {
          createdProviderOrders.push(payload)
          return {
            id: `order_emulator${normalizedSuffix}${createdProviderOrders.length}`,
            amount: payload.amount,
            currency: payload.currency,
          }
        },
      },
      payments: {
        async fetch(id) {
          return providerPayments.get(id)
        },
      },
    }
    const firstPaymentOrder = await createRazorpayPaymentOrder({
      reservationId: reservation.reservationId,
      cancellationToken: reservation.cancellationToken,
      idempotencyKey: `payment-attempt-${normalizedSuffix}-1`,
    }, {
      firestore,
      keyId,
      publicKeyId: keyId,
      keySecret,
      razorpay: gateway,
    })
    assert.equal(createdProviderOrders.length, 1)
    assert.equal(createdProviderOrders[0].amount, 539800)
    assert.equal(createdProviderOrders[0].currency, 'INR')
    assert.match(createdProviderOrders[0].receipt, /^payment-[a-f0-9]{32}$/)

    providerPayments.set(failedPaymentId, {
      id: failedPaymentId,
      order_id: firstPaymentOrder.razorpayOrderId,
      amount: 539800,
      currency: 'INR',
      status: 'failed',
    })
    const signature = createHmac('sha256', keySecret)
      .update(`${firstPaymentOrder.razorpayOrderId}|${failedPaymentId}`)
      .digest('hex')
    const failedVerification = await verifyRazorpayPayment({
      razorpay_order_id: firstPaymentOrder.razorpayOrderId,
      razorpay_payment_id: failedPaymentId,
      razorpay_signature: signature,
    }, {
      firestore,
      keyId,
      publicKeyId: keyId,
      keySecret,
      razorpay: gateway,
    })
    assert.equal(failedVerification.status, 'failed')
    assert.equal((await firestore.collection('products').doc(firstProductId).get()).data().reservedStock, 0)
    assert.equal((await firestore.collection('products').doc(secondProductId).get()).data().reservedStock, 0)

    const retryPaymentOrder = await createRazorpayPaymentOrder({
      reservationId: reservation.reservationId,
      cancellationToken: reservation.cancellationToken,
      idempotencyKey: `payment-attempt-${normalizedSuffix}-2`,
    }, {
      firestore,
      keyId,
      publicKeyId: keyId,
      keySecret,
      razorpay: gateway,
    })
    assert.notEqual(retryPaymentOrder.razorpayOrderId, firstPaymentOrder.razorpayOrderId)
    assert.equal(createdProviderOrders.length, 2)
    assert.deepEqual(createdProviderOrders.map(({ amount, currency }) => ({ amount, currency })), [
      { amount: 539800, currency: 'INR' },
      { amount: 539800, currency: 'INR' },
    ])
    assert.equal((await firestore.collection('products').doc(firstProductId).get()).data().reservedStock, 1)
    assert.equal((await firestore.collection('products').doc(secondProductId).get()).data().reservedStock, 1)

    const capturedPayment = {
      id: capturedPaymentId,
      order_id: retryPaymentOrder.razorpayOrderId,
      amount: 539800,
      currency: 'INR',
      status: 'captured',
    }
    const failedPaymentEvent = {
      id: failedPaymentId,
      order_id: firstPaymentOrder.razorpayOrderId,
      amount: 539800,
      currency: 'INR',
      status: 'failed',
    }
    const dispatchSignedWebhook = async (eventId, event, payment) => {
      const rawBody = Buffer.from(JSON.stringify({
        event,
        payload: { payment: { entity: payment } },
      }))
      const response = {
        headers: {},
        setHeader(name, value) { this.headers[name] = value },
        status(code) { this.statusCode = code; return this },
        json(body) { this.body = body; return this },
        end(body) { this.body = JSON.parse(body) },
      }
      await webhookHandler({
        method: 'POST',
        headers: {
          'x-razorpay-signature': createHmac('sha256', webhookSecret).update(rawBody).digest('hex'),
          'x-razorpay-event-id': eventId,
        },
        rawBody,
      }, response, {
        webhookSecret,
        getTestConfiguration: () => ({ keyId, publicKeyId: keyId, keySecret }),
        processEvent: (webhookEvent, options) => processRazorpayWebhookEvent(webhookEvent, {
          firestore,
          keyId,
          publicKeyId: keyId,
          keySecret,
          razorpay: gateway,
          ...options,
        }),
        rateLimit: () => true,
      })
      assert.equal(response.statusCode, 200, response.body?.message)
      return response.body
    }

    const capturedWebhook = await dispatchSignedWebhook(
      capturedEventId,
      'payment.captured',
      capturedPayment,
    )
    assert.equal(capturedWebhook.outcome, 'captured')
    const duplicateWebhook = await dispatchSignedWebhook(
      capturedEventId,
      'payment.captured',
      capturedPayment,
    )
    assert.equal(duplicateWebhook.duplicate, true)
    await dispatchSignedWebhook(
      delayedFailureEventId,
      'payment.failed',
      failedPaymentEvent,
    )

    const storedOrderQuery = await firestore.collection('orders')
      .where('reservationId', '==', reservation.reservationId)
      .limit(1)
      .get()
    assert.equal(storedOrderQuery.size, 1)
    const storedOrder = storedOrderQuery.docs[0].data()
    assert.equal(storedOrder.orderStatus, 'confirmed')
    assert.equal(storedOrder.totalAmount, 5398)
    assert.equal(storedOrder.items.length, 2)
    assert.equal(storedOrder.paymentStatus, 'captured')
    assert.equal(storedOrder.razorpayPaymentId, capturedPaymentId)
    assert.equal(storedOrder.paymentAmountPaise, 539800)
    assert.equal(Object.keys(storedOrder.paymentAttempts).length, 2)
    assert.deepEqual(Object.values(storedOrder.paymentAttempts).map(({ status }) => status), ['failed', 'captured'])
    assert.deepEqual(storedOrder.items.map(({ productId, price, quantity }) => ({ productId, price, quantity })), [
      { productId: firstProductId, price: 2499, quantity: 1 },
      { productId: secondProductId, price: 2899, quantity: 1 },
    ])
    assert.deepEqual(storedOrder.items.map(({ selectedSize }) => selectedSize), ['5.5 m', '6.3 m'])
    const { getCustomerReservationStatus } = await import('../server/reservationService.js')
    const customerStatus = await getCustomerReservationStatus(
      reservation.reservationId,
      reservation.cancellationToken,
      { firestore },
    )
    assert.equal(customerStatus.paymentStatus, 'captured')
    assert.equal(customerStatus.orderStatus, 'confirmed')
    assert.equal(customerStatus.totalAmount, 5398)
    assert.equal(customerStatus.items.length, 2)
    assert.deepEqual(customerStatus.items.map(({ productName, selectedSize }) => ({ productName, selectedSize })), [
      { productName: 'Floral Dola Silk Fancy Saree', selectedSize: '5.5 m' },
      { productName: 'Mangalagiri Handloom Cotton Saree', selectedSize: '6.3 m' },
    ])
    assert.ok(Number.isFinite(Date.parse(customerStatus.createdAt)))
    for (const productId of [firstProductId, secondProductId]) {
      const product = (await firestore.collection('products').doc(productId).get()).data()
      assert.equal(product.totalStock, 0)
      assert.equal(product.reservedStock, 0)
    }
    const inventoryHistory = await firestore.collection('inventoryHistory')
      .where('reservationId', '==', reservation.reservationId)
      .get()
    const fulfilledProducts = inventoryHistory.docs
      .filter((document) => document.data().actionType === 'convert')
      .map((document) => document.data().productId)
      .sort()
    assert.deepEqual(fulfilledProducts, [firstProductId, secondProductId].sort())
  } finally {
    if (reservation?.reservationId) {
      const orders = await firestore.collection('orders')
        .where('reservationId', '==', reservation.reservationId)
        .get()
      await Promise.all(orders.docs.map((document) => document.ref.delete()))
      const history = await firestore.collection('inventoryHistory')
        .where('reservationId', '==', reservation.reservationId)
        .get()
      await Promise.all(history.docs.map((document) => document.ref.delete()))
      await firestore.collection('reservationTokens').doc(reservation.reservationId).delete()
    }
    for (const eventId of webhookEventIds) {
      const events = await firestore.collection('razorpayWebhookEvents')
        .where('eventId', '==', eventId)
        .get()
      await Promise.all(events.docs.map((document) => document.ref.delete()))
    }
    await firestore.collection('reservationRequests').doc(reservationRequestKey).delete()
    await firestore.collection('products').doc(firstProductId).delete()
    await firestore.collection('products').doc(secondProductId).delete()
  }
})
