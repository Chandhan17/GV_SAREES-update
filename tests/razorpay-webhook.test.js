import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import webhookHandler from '../api/razorpay/webhook.js'
import {
  processRazorpayWebhookEvent,
  verifyRazorpayWebhookSignature,
} from '../server/razorpayWebhookService.js'
import { confirmReservation } from '../server/reservationService.js'

const webhookSecret = 'test-webhook-secret-that-is-long-enough'
const paymentKeyConfiguration = {
  keyId: 'rzp_test_example',
  publicKeyId: 'rzp_test_example',
  keySecret: 'test-secret-not-a-real-credential',
}
const reservationId = 'cc970f63-fbe7-46b3-bd65-bd623f25c039'
const receipt = 'payment-0123456789abcdef0123456789abcdef'
const attemptKey = 'attempt-key-hash'
const razorpayOrderId = 'order_webhook1'

function createMockFirestore({
  storedOrderId = true,
  attemptOrderId = storedOrderId ? razorpayOrderId : undefined,
  expired = false,
  failEventLookup = false,
  failOrderLookup = false,
} = {}) {
  const collections = new Map([
    ['orders', new Map([
      ['application-order-1', {
        reservationId,
        productId: 'product-1',
        reservationStatus: 'active',
        reservedQuantity: 2,
        expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)),
        paymentMethod: 'razorpay',
        paymentStatus: 'pending',
        paymentAmountPaise: 5150,
        paymentCurrency: 'INR',
        paymentIdempotencyKeyHash: attemptKey,
        paymentAttempts: {
          [attemptKey]: {
            status: storedOrderId ? 'pending' : 'creating',
            amount: 5150,
            currency: 'INR',
            receipt,
            ...(attemptOrderId ? { razorpayOrderId: attemptOrderId } : {}),
          },
        },
        razorpayOrderIds: storedOrderId ? [razorpayOrderId] : [],
        razorpayReceipts: [receipt],
        orderStatus: 'initiated',
        stockDeducted: false,
        stockRestored: false,
      }],
    ])],
    ['products', new Map([
      ['product-1', {
        totalStock: 5,
        reservedStock: 2,
        availableStock: 3,
      }],
    ])],
    ['razorpayWebhookEvents', new Map()],
  ])
  let transactionTail = Promise.resolve()
  let updateCount = 0
  let generatedDocumentId = 0

  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const makeRef = (name, id) => ({
    collectionName: name,
    id,
    async get() {
      if (name === 'razorpayWebhookEvents' && failEventLookup) {
        throw new Error('Simulated Firestore event lookup failure.')
      }
      return makeSnapshot(this)
    },
  })
  const makeSnapshot = (ref) => {
    const value = getCollection(ref.collectionName).get(ref.id)
    return {
      id: ref.id,
      ref,
      exists: value !== undefined,
      data: () => value && { ...value },
    }
  }
  const firestore = {
    collection(name) {
      return {
        doc(id) {
          return makeRef(name, id || `generated-${++generatedDocumentId}`)
        },
        where(field, operator, value) {
          return {
            limit(limitCount) {
              return {
                async get() {
                  if (name === 'orders' && failOrderLookup) {
                    throw new Error('Simulated Firestore order lookup failure.')
                  }
                  const docs = [...getCollection(name).entries()]
                    .filter(([, document]) => operator === 'array-contains'
                      ? document[field]?.includes(value)
                      : document[field] === value)
                    .slice(0, limitCount)
                    .map(([id]) => {
                      const ref = makeRef(name, id)
                      return { id, ref, data: () => makeSnapshot(ref).data() }
                    })
                  return { docs, empty: docs.length === 0 }
                },
              }
            },
          }
        },
      }
    },
    async runTransaction(work) {
      const previous = transactionTail
      let release
      transactionTail = new Promise((resolve) => {
        release = resolve
      })
      await previous
      try {
        const writes = []
        const transaction = {
          async get(ref) {
            return makeSnapshot(ref)
          },
          update(ref, patch) {
            writes.push({ kind: 'update', ref, data: patch })
          },
          set(ref, data) {
            writes.push({ kind: 'set', ref, data })
          },
          create(ref, data) {
            writes.push({ kind: 'create', ref, data })
          },
        }
        const result = await work(transaction)
        for (const write of writes) {
          const documents = getCollection(write.ref.collectionName)
          if (write.kind === 'create') {
            if (documents.has(write.ref.id)) throw new Error('Document already exists.')
            documents.set(write.ref.id, write.data)
          } else if (write.kind === 'set') {
            documents.set(write.ref.id, write.data)
          } else {
            const current = documents.get(write.ref.id)
            assert.ok(current, `Missing ${write.ref.collectionName}/${write.ref.id}`)
            documents.set(write.ref.id, { ...current, ...write.data })
          }
          updateCount += 1
        }
        return result
      } finally {
        release()
      }
    },
  }

  return {
    firestore,
    get(name, id) {
      const value = getCollection(name).get(id)
      return value && { ...value }
    },
    list(name) {
      return [...getCollection(name).values()]
    },
    update(name, id, patch) {
      const current = getCollection(name).get(id)
      if (current) getCollection(name).set(id, { ...current, ...patch })
    },
    get updateCount() {
      return updateCount
    },
  }
}

function createGateway({ orderReceipt = receipt, amount = 5150 } = {}) {
  return {
    orders: {
      async fetch(id) {
        return {
          id,
          receipt: orderReceipt,
          amount,
          currency: 'INR',
        }
      },
    },
  }
}

function paymentEvent(event, {
  paymentId = 'pay_webhook1',
  orderId = razorpayOrderId,
  status = event.split('.')[1],
  amount = 5150,
  currency = 'INR',
} = {}) {
  return {
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          status,
          amount,
          currency,
        },
      },
    },
  }
}

function signWebhook(rawBody, secret = webhookSecret) {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function createApiResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}

function createNodeResponseAdapter(response) {
  return {
    setHeader: response.setHeader.bind(response),
    get statusCode() {
      return response.statusCode
    },
    set statusCode(statusCode) {
      response.statusCode = statusCode
    },
    status(statusCode) {
      response.statusCode = statusCode
      return this
    },
    json(body) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
      return this
    },
    end(body) {
      response.end(body)
      return this
    },
  }
}

function webhookRequest(rawBody, signature = signWebhook(rawBody), eventId = 'evt_test_1') {
  return {
    method: 'POST',
    headers: {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    rawBody: Buffer.from(rawBody),
  }
}

function webhookRequestWithBody(body, signature, eventId = 'evt_test_body') {
  return {
    method: 'POST',
    headers: {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body,
  }
}

const paymentServiceOptions = (firestore, razorpay = createGateway()) => ({
  ...paymentKeyConfiguration,
  firestore,
  razorpay,
})

test('Firestore event idempotency lookup failure is surfaced and timed', async () => {
  const mock = createMockFirestore({ failEventLookup: true })
  const stages = []

  await assert.rejects(processRazorpayWebhookEvent({
    eventId: 'evt_firestore_lookup_error',
    ...paymentEvent('payment.captured'),
  }, {
    ...paymentServiceOptions(mock.firestore),
    onStage: (stage) => stages.push(stage),
  }), /Simulated Firestore event lookup failure/)

  assert.deepEqual(stages, [
    'event_idempotency_lookup:start',
    'event_idempotency_lookup:error',
  ])
})

test('Firestore application order lookup failure is surfaced and timed', async () => {
  const mock = createMockFirestore({ failOrderLookup: true })
  const stages = []

  await assert.rejects(processRazorpayWebhookEvent({
    eventId: 'evt_order_lookup_error',
    ...paymentEvent('payment.captured'),
  }, {
    ...paymentServiceOptions(mock.firestore),
    onStage: (stage) => stages.push(stage),
  }), /Simulated Firestore order lookup failure/)

  assert.deepEqual(stages, [
    'event_idempotency_lookup:start',
    'event_idempotency_lookup:complete',
    'application_order_lookup:start',
    'application_order_lookup:error',
  ])
})

test('Razorpay order reconciliation timeout fails without recording payment state', async () => {
  const mock = createMockFirestore({ storedOrderId: false })
  const stages = []
  const gateway = {
    orders: {
      fetch: () => new Promise(() => {}),
    },
  }

  await assert.rejects(processRazorpayWebhookEvent({
    eventId: 'evt_provider_timeout',
    ...paymentEvent('payment.captured'),
  }, {
    ...paymentServiceOptions(mock.firestore, gateway),
    onStage: (stage) => stages.push(stage),
    providerTimeoutMs: 10,
  }), (error) => error.code === 'PAYMENT_PROVIDER_TIMEOUT')

  assert.deepEqual(stages, [
    'event_idempotency_lookup:start',
    'event_idempotency_lookup:complete',
    'application_order_lookup:start',
    'application_order_lookup:complete',
    'razorpay_reconciliation:start',
    'razorpay_reconciliation:error',
  ])
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
  assert.equal(mock.list('razorpayWebhookEvents').length, 0)
})

test('unmatched generic Payment Link payment events are acknowledged and recorded as ignored', async () => {
  const mock = createMockFirestore({ storedOrderId: false })
  const event = {
    eventId: 'evt_unrelated_link_payment',
    ...paymentEvent('payment.captured', {
      orderId: 'order_paymentlink1',
      paymentId: 'pay_paymentlink1',
      amount: 1000,
    }),
  }
  const options = paymentServiceOptions(
    mock.firestore,
    createGateway({ orderReceipt: 'payment-link-reference', amount: 1000 }),
  )

  const first = await processRazorpayWebhookEvent(event, options)
  const duplicate = await processRazorpayWebhookEvent(event, options)
  const order = mock.get('orders', 'application-order-1')

  assert.deepEqual(first, { duplicate: false, outcome: 'ignored' })
  assert.deepEqual(duplicate, { duplicate: true, outcome: 'ignored' })
  assert.equal(mock.list('razorpayWebhookEvents').length, 1)
  assert.equal(order.paymentStatus, 'pending')
  assert.equal(order.paymentAttempts[attemptKey].status, 'creating')
  assert.deepEqual(order.razorpayOrderIds, [])
})

test('a valid GV Sarees payment event still updates its matching attempt', async () => {
  const mock = createMockFirestore()
  const result = await processRazorpayWebhookEvent({
    eventId: 'evt_matching_gv_payment',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(mock.firestore))

  assert.deepEqual(result, { duplicate: false, outcome: 'captured' })
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'captured')
})

test('matching order with a mismatched payment amount is rejected without updating the order', async () => {
  const mock = createMockFirestore()

  await assert.rejects(processRazorpayWebhookEvent({
    eventId: 'evt_mismatched_amount',
    ...paymentEvent('payment.captured', { amount: 1000 }),
  }, paymentServiceOptions(mock.firestore)), {
    code: 'PAYMENT_DETAILS_MISMATCH',
  })

  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
  assert.equal(mock.list('razorpayWebhookEvents').length, 0)
})

test('receipt match cannot override a different Razorpay order ID on the stored attempt', async () => {
  const mock = createMockFirestore({
    storedOrderId: false,
    attemptOrderId: 'order_previously_associated',
  })
  const event = paymentEvent('payment.captured', { orderId: 'order_differentattempt' })

  await assert.rejects(processRazorpayWebhookEvent({
    eventId: 'evt_mismatched_order_id',
    ...event,
  }, paymentServiceOptions(mock.firestore)), {
    code: 'PAYMENT_ORDER_MISMATCH',
  })

  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
  assert.equal(mock.list('razorpayWebhookEvents').length, 0)
})

test('unsupported Payment Link events are recorded idempotently and never reconcile orders', async () => {
  const mock = createMockFirestore()
  const stages = []
  let providerFetchCount = 0
  const gateway = {
    orders: {
      async fetch() {
        providerFetchCount += 1
        throw new Error('Unsupported event must not fetch provider order.')
      },
    },
  }
  const event = {
    eventId: 'evt_payment_link_ignored',
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: 'plink_synthetic' } } },
  }
  const options = {
    ...paymentServiceOptions(mock.firestore, gateway),
    onStage: (stage) => stages.push(stage),
  }

  const first = await processRazorpayWebhookEvent(event, options)
  const duplicate = await processRazorpayWebhookEvent(event, options)

  assert.deepEqual(first, { duplicate: false, outcome: 'ignored' })
  assert.deepEqual(duplicate, { duplicate: true, outcome: 'ignored' })
  assert.equal(providerFetchCount, 0)
  assert.equal(mock.list('razorpayWebhookEvents').length, 1)
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'pending')
  assert.ok(stages.includes('firestore_transaction:complete'))
})

test('webhook signature verifies the exact raw bytes', () => {
  const exactBody = Buffer.from(' {\n  "event": "payment.captured"\n} \n')
  const exactSignature = signWebhook(exactBody)
  assert.equal(verifyRazorpayWebhookSignature(exactBody, exactSignature, webhookSecret), true)
  assert.equal(verifyRazorpayWebhookSignature(Buffer.from(exactBody.toString().trim()), exactSignature, webhookSecret), false)
  assert.equal(verifyRazorpayWebhookSignature(exactBody, '0'.repeat(64), webhookSecret), false)
})

test('webhook endpoint rejects missing and invalid signatures without processing events', async () => {
  let processed = false
  const processEvent = async () => {
    processed = true
    return { duplicate: false }
  }
  const rawBody = JSON.stringify(paymentEvent('payment.captured'))

  const missingSignature = createApiResponse()
  await webhookHandler({
    ...webhookRequest(rawBody),
    headers: { 'x-razorpay-event-id': 'evt_missing_sig' },
  }, missingSignature, {
    webhookSecret,
    processEvent,
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  })
  assert.equal(missingSignature.statusCode, 400)

  const invalidSignature = createApiResponse()
  await webhookHandler(webhookRequest(rawBody, '0'.repeat(64)), invalidSignature, {
    webhookSecret,
    processEvent,
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  })
  assert.equal(invalidSignature.statusCode, 403)
  assert.equal(processed, false)
})

test('webhook endpoint preserves Buffer, Uint8Array, and string request bodies', async () => {
  const rawBody = JSON.stringify(paymentEvent('payment.captured'))
  const rawBytes = Buffer.from(rawBody, 'utf8')
  const bodyRepresentations = [
    ['Buffer', Buffer.from(rawBytes)],
    ['Uint8Array', new Uint8Array(rawBytes)],
    ['string', rawBody],
  ]

  for (const [representation, body] of bodyRepresentations) {
    const response = createApiResponse()
    await webhookHandler(webhookRequestWithBody(
      body,
      signWebhook(rawBytes),
      `evt_body_${representation}`,
    ), response, {
      webhookSecret,
      processEvent: async () => ({ duplicate: false, outcome: 'captured' }),
      getTestConfiguration: () => ({}),
      rateLimit: () => true,
    })
    assert.equal(response.statusCode, 200, `${representation} body should be accepted`)
  }
})

test('webhook endpoint reads exact bytes from a request stream before accessing parsed body', async () => {
  const rawBody = ` ${JSON.stringify(paymentEvent('payment.captured'))} \n`
  const request = Readable.from([Buffer.from(rawBody, 'utf8')])
  request.method = 'POST'
  request.headers = {
    'x-razorpay-signature': signWebhook(rawBody),
    'x-razorpay-event-id': 'evt_readable_stream',
  }
  const response = createApiResponse()

  await webhookHandler(request, response, {
    webhookSecret,
    processEvent: async () => ({ duplicate: false, outcome: 'captured' }),
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.outcome, 'captured')
})

test('HTTP harness accepts a valid signature and rejects an invalid signature without backend access', async (t) => {
  let processCount = 0
  const server = createServer((request, response) => {
    void webhookHandler(request, createNodeResponseAdapter(response), {
      webhookSecret,
      processEvent: async () => {
        processCount += 1
        return { duplicate: false, outcome: 'synthetic_event_accepted' }
      },
      getTestConfiguration: () => ({}),
      rateLimit: () => true,
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/api/razorpay/webhook`
  const rawBody = JSON.stringify(paymentEvent('payment.captured'))
  const validResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signWebhook(rawBody),
      'X-Razorpay-Event-Id': 'evt_http_valid',
    },
    body: rawBody,
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(validResponse.status, 200)
  assert.equal((await validResponse.json()).outcome, 'synthetic_event_accepted')

  const invalidResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': '0'.repeat(64),
      'X-Razorpay-Event-Id': 'evt_http_invalid',
    },
    body: rawBody,
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(invalidResponse.status, 403)
  assert.equal(processCount, 1)
})

test('webhook endpoint rejects missing and parsed-object bodies without dispatching', async () => {
  let processed = false
  const processEvent = async () => {
    processed = true
    return { duplicate: false }
  }
  const headers = {
    'x-razorpay-signature': signWebhook('{}'),
    'x-razorpay-event-id': 'evt_missing_body',
  }
  const options = {
    webhookSecret,
    processEvent,
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  }

  const missingBody = createApiResponse()
  await webhookHandler({ method: 'POST', headers }, missingBody, options)
  assert.equal(missingBody.statusCode, 400)

  const parsedObjectBody = createApiResponse()
  await webhookHandler({
    method: 'POST',
    headers: { ...headers, 'x-razorpay-event-id': 'evt_parsed_body' },
    body: paymentEvent('payment.captured'),
  }, parsedObjectBody, options)
  assert.equal(parsedObjectBody.statusCode, 400)
  assert.equal(processed, false)
})

test('webhook endpoint verifies signature before parsing and dispatching the raw body', async () => {
  let dispatched
  const rawBody = ` ${JSON.stringify(paymentEvent('payment.captured'))} \n`
  const response = createApiResponse()
  await webhookHandler(webhookRequest(rawBody), response, {
    webhookSecret,
    processEvent: async (event) => {
      dispatched = event
      return { duplicate: false, outcome: 'captured' }
    },
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.outcome, 'captured')
  assert.equal(dispatched.event, 'payment.captured')

  const invalidJson = createApiResponse()
  const malformedBody = '{'
  await webhookHandler(webhookRequest(malformedBody), invalidJson, {
    webhookSecret,
    processEvent: async () => {
      throw new Error('Must not dispatch invalid JSON.')
    },
    getTestConfiguration: () => ({}),
    rateLimit: () => true,
  })
  assert.equal(invalidJson.statusCode, 400)
})

test('captured webhook updates payment only and duplicate delivery is idempotent', async () => {
  const mock = createMockFirestore()
  const event = paymentEvent('payment.captured')
  const first = await processRazorpayWebhookEvent({
    eventId: 'evt_captured_1',
    ...event,
  }, paymentServiceOptions(mock.firestore))
  const updatesAfterFirst = mock.updateCount
  const duplicate = await processRazorpayWebhookEvent({
    eventId: 'evt_captured_1',
    ...event,
  }, paymentServiceOptions(mock.firestore))
  const order = mock.get('orders', 'application-order-1')

  assert.equal(first.outcome, 'captured')
  assert.deepEqual(duplicate, { duplicate: true, outcome: 'captured' })
  assert.equal(mock.updateCount, updatesAfterFirst)
  assert.equal(mock.list('razorpayWebhookEvents').length, 1)
  assert.equal(order.paymentStatus, 'captured')
  assert.equal(order.orderStatus, 'confirmed')
  assert.equal(order.stockDeducted, true)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
})

test('concurrent duplicate webhook deliveries apply one update', async () => {
  const mock = createMockFirestore()
  const event = paymentEvent('payment.captured')
  const results = await Promise.all([
    processRazorpayWebhookEvent({ eventId: 'evt_concurrent_1', ...event }, paymentServiceOptions(mock.firestore)),
    processRazorpayWebhookEvent({ eventId: 'evt_concurrent_1', ...event }, paymentServiceOptions(mock.firestore)),
  ])

  assert.equal(results.filter((result) => result.duplicate).length, 1)
  assert.equal(mock.list('razorpayWebhookEvents').length, 1)
  assert.equal(mock.get('orders', 'application-order-1').paymentStatus, 'captured')
  assert.equal(mock.updateCount, 4)
})

test('authorized and failed events update their own states without downgrading captured payments', async () => {
  const authorizedMock = createMockFirestore()
  await processRazorpayWebhookEvent({
    eventId: 'evt_authorized_1',
    ...paymentEvent('payment.authorized'),
  }, paymentServiceOptions(authorizedMock.firestore))
  assert.equal(authorizedMock.get('orders', 'application-order-1').paymentStatus, 'authorized')

  const failedMock = createMockFirestore()
  const failedEvent = paymentEvent('payment.failed', { status: 'failed' })
  await processRazorpayWebhookEvent({
    eventId: 'evt_authorized_before_failure',
    ...paymentEvent('payment.authorized'),
  }, paymentServiceOptions(failedMock.firestore))
  await processRazorpayWebhookEvent({
    eventId: 'evt_failed_1',
    ...failedEvent,
  }, paymentServiceOptions(failedMock.firestore))
  assert.equal(failedMock.get('orders', 'application-order-1').paymentStatus, 'failed')
  assert.equal(failedMock.get('orders', 'application-order-1').stockReserved, false)
  assert.deepEqual(
    [failedMock.get('products', 'product-1').reservedStock, failedMock.get('products', 'product-1').availableStock],
    [0, 5],
  )

  const capturedMock = createMockFirestore()
  await processRazorpayWebhookEvent({
    eventId: 'evt_captured_first',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(capturedMock.firestore))
  await processRazorpayWebhookEvent({
    eventId: 'evt_failed_after_capture',
    ...failedEvent,
  }, paymentServiceOptions(capturedMock.firestore))
  assert.equal(capturedMock.get('orders', 'application-order-1').paymentStatus, 'captured')
})

test('duplicate failure webhook events release reserved stock once', async () => {
  const mock = createMockFirestore()
  const event = paymentEvent('payment.failed', { status: 'failed' })

  const first = await processRazorpayWebhookEvent({
    eventId: 'evt_failure_release_1',
    ...event,
  }, paymentServiceOptions(mock.firestore))
  const duplicateDelivery = await processRazorpayWebhookEvent({
    eventId: 'evt_failure_release_1',
    ...event,
  }, paymentServiceOptions(mock.firestore))
  await processRazorpayWebhookEvent({
    eventId: 'evt_failure_release_2',
    ...event,
  }, paymentServiceOptions(mock.firestore))

  assert.equal(first.outcome, 'failed')
  assert.deepEqual(duplicateDelivery, { duplicate: true, outcome: 'failed' })
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )
  assert.equal(mock.get('orders', 'application-order-1').stockReserved, false)
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 1)
  assert.equal(mock.list('razorpayWebhookEvents').length, 2)
})

test('failure webhook after checkout dismissal does not release inventory twice', async () => {
  const mock = createMockFirestore()
  mock.update('orders', 'application-order-1', {
    stockReserved: false,
    inventoryOwnershipStatus: 'released',
    reservationStatus: 'released',
    checkoutAbandoned: true,
    paymentReconciliationStatus: 'pending',
  })
  mock.update('products', 'product-1', {
    reservedStock: 0,
    availableStock: 5,
  })
  const event = paymentEvent('payment.failed', { status: 'failed' })
  await processRazorpayWebhookEvent({
    eventId: 'evt_dismissed_then_failure',
    ...event,
  }, paymentServiceOptions(mock.firestore))
  const order = mock.get('orders', 'application-order-1')

  assert.equal(order.paymentStatus, 'failed')
  assert.equal(order.checkoutAbandoned, true)
  assert.deepEqual(
    [mock.get('products', 'product-1').reservedStock, mock.get('products', 'product-1').availableStock],
    [0, 5],
  )
  assert.equal(mock.list('inventoryHistory').filter((entry) => entry.actionType === 'release').length, 0)
})

test('late captured payment after failure is protected and fulfills the order', async () => {
  const mock = createMockFirestore()
  await processRazorpayWebhookEvent({
    eventId: 'evt_fail_then_capture_1',
    ...paymentEvent('payment.failed', { status: 'failed' }),
  }, paymentServiceOptions(mock.firestore))
  await processRazorpayWebhookEvent({
    eventId: 'evt_fail_then_capture_2',
    ...paymentEvent('payment.captured', { status: 'captured' }),
  }, paymentServiceOptions(mock.firestore))

  const order = mock.get('orders', 'application-order-1')
  assert.equal(order.paymentStatus, 'captured')
  assert.equal(order.orderStatus, 'confirmed')
  assert.equal(order.paymentAttempts[attemptKey].payments.pay_webhook1.status, 'captured')
})

test('captured payment after expiry is fulfilled when the reservation still owns its inventory', async () => {
  const mock = createMockFirestore({ expired: true })
  await processRazorpayWebhookEvent({
    eventId: 'evt_late_capture_1',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(mock.firestore))

  const order = mock.get('orders', 'application-order-1')
  assert.equal(order.paymentStatus, 'captured')
  assert.equal(order.paymentReconciliationStatus, null)
  assert.equal(order.reservationStatus, 'converted')
  assert.equal(order.orderStatus, 'confirmed')
  assert.equal(order.stockDeducted, true)
  assert.equal(mock.get('products', 'product-1').reservedStock, 0)
})

test('late capture reacquires available inventory before confirmation', async () => {
  const mock = createMockFirestore()
  mock.update('orders', 'application-order-1', {
    stockReserved: false,
    inventoryOwnershipStatus: 'released',
    reservationStatus: 'released',
    checkoutAbandoned: true,
    paymentReconciliationStatus: 'pending',
  })
  mock.update('products', 'product-1', {
    reservedStock: 0,
    availableStock: 5,
  })

  const result = await processRazorpayWebhookEvent({
    eventId: 'evt_late_capture_stock_available',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(mock.firestore))
  const capturedOrder = mock.get('orders', 'application-order-1')

  assert.equal(result.outcome, 'captured')
  assert.equal(capturedOrder.stockReserved, false)
  assert.equal(capturedOrder.inventoryOwnershipStatus, 'consumed')
  assert.equal(capturedOrder.paymentReconciliationStatus, null)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [3, 0],
  )

  const confirmation = await confirmReservation(reservationId, 'admin-1', { firestore: mock.firestore })
  assert.equal(confirmation.status, 'converted')
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [3, 0],
  )
})

test('capture after expiry fallback release still fulfills available inventory', async () => {
  const mock = createMockFirestore({ expired: true })
  mock.update('orders', 'application-order-1', {
    stockReserved: false,
    inventoryOwnershipStatus: 'released_pending_verification',
    reservationStatus: 'expired',
    checkoutAbandoned: true,
    paymentReconciliationStatus: 'pending',
  })
  mock.update('products', 'product-1', { reservedStock: 0, availableStock: 5 })

  const result = await processRazorpayWebhookEvent({
    eventId: 'evt_capture_after_expiry_release',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(mock.firestore))
  const order = mock.get('orders', 'application-order-1')

  assert.equal(result.outcome, 'captured')
  assert.equal(order.orderStatus, 'confirmed')
  assert.equal(order.reservationStatus, 'converted')
  assert.equal(order.stockDeducted, true)
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [3, 0],
  )
})

test('late capture with insufficient inventory requires manual review and cannot be confirmed', async () => {
  const mock = createMockFirestore()
  mock.update('orders', 'application-order-1', {
    stockReserved: false,
    inventoryOwnershipStatus: 'released',
    reservationStatus: 'released',
    checkoutAbandoned: true,
    paymentReconciliationStatus: 'pending',
  })
  mock.update('products', 'product-1', {
    reservedStock: 5,
    availableStock: 0,
  })

  const result = await processRazorpayWebhookEvent({
    eventId: 'evt_late_capture_stock_unavailable',
    ...paymentEvent('payment.captured'),
  }, paymentServiceOptions(mock.firestore))
  const order = mock.get('orders', 'application-order-1')

  assert.equal(result.outcome, 'manual_review')
  assert.equal(order.paymentStatus, 'captured')
  assert.equal(order.paymentReconciliationStatus, 'manual_review')
  assert.equal(order.paymentReconciliationReason, 'captured_payment_without_available_inventory')
  assert.equal(order.refundRequired, true)
  assert.equal(order.orderStatus, 'initiated')
  assert.equal(order.stockReserved, false)
  await assert.rejects(
    confirmReservation(reservationId, 'admin-1', { firestore: mock.firestore }),
    { code: 'PAYMENT_REQUIRES_REFUND' },
  )
  assert.deepEqual(
    [mock.get('products', 'product-1').totalStock, mock.get('products', 'product-1').reservedStock],
    [5, 5],
  )
})

test('order.paid automatically confirms and deducts stock for captured payment', async () => {
  const mock = createMockFirestore()
  const event = {
    event: 'order.paid',
    payload: {
      order: {
        entity: {
          id: razorpayOrderId,
          status: 'paid',
          amount_paid: 5150,
          currency: 'INR',
          receipt,
        },
      },
    },
  }
  await processRazorpayWebhookEvent({
    eventId: 'evt_order_paid_1',
    ...event,
  }, paymentServiceOptions(mock.firestore))

  const order = mock.get('orders', 'application-order-1')
  assert.equal(order.paymentStatus, 'captured')
  assert.equal(order.orderStatus, 'confirmed')
  assert.equal(order.stockDeducted, true)
})

test('incomplete Razorpay order persistence is reconciled by deterministic receipt', async () => {
  const mock = createMockFirestore({ storedOrderId: false })
  const event = paymentEvent('payment.captured')
  const stages = []
  await processRazorpayWebhookEvent({
    eventId: 'evt_reconcile_1',
    ...event,
  }, {
    ...paymentServiceOptions(mock.firestore, createGateway()),
    onStage: (stage) => stages.push(stage),
  })

  const order = mock.get('orders', 'application-order-1')
  assert.deepEqual(order.razorpayOrderIds, [razorpayOrderId])
  assert.equal(order.paymentAttempts[attemptKey].razorpayOrderId, razorpayOrderId)
  assert.equal(order.paymentAttempts[attemptKey].status, 'captured')
  assert.equal(order.paymentStatus, 'captured')
  assert.deepEqual(stages, [
    'event_idempotency_lookup:start',
    'event_idempotency_lookup:complete',
    'application_order_lookup:start',
    'application_order_lookup:complete',
    'razorpay_reconciliation:start',
    'razorpay_reconciliation:complete',
    'receipt_lookup:start',
    'receipt_lookup:complete',
    'firestore_transaction:start',
    'firestore_transaction:complete',
  ])
})

test('invalid event payloads are rejected without recording a processed event', async () => {
  const mock = createMockFirestore()
  await assert.rejects(
    processRazorpayWebhookEvent({
      eventId: 'evt_invalid_payload_1',
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'invalid' } } },
    }, paymentServiceOptions(mock.firestore)),
    { code: 'INVALID_WEBHOOK_EVENT' },
  )
  assert.equal(mock.list('razorpayWebhookEvents').length, 0)
})
