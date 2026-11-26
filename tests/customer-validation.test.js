import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import handler from '../api/reservations/create.js'
import { reservationSchema } from '../server/validation.js'
import {
  normalizeIndianMobileNumber,
  parseReservationQuantity,
  reservationQuantityError,
} from '../shared/customerValidation.js'

const validRequest = {
  productId: 'product-1',
  quantity: 3,
  idempotencyKey: 'reservation-request-key-123456',
  customer: {
    name: '  Test   Customer ',
    phone: '+91 98765 43210',
    doorNo: '  12 ',
    streetName: ' Main   Road ',
    city: ' Chennai ',
    pincode: '600001',
    state: ' Tamil Nadu ',
  },
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}

test('valid Indian mobile numbers normalize with or without country code and spaces', () => {
  assert.equal(normalizeIndianMobileNumber('9876543210'), '9876543210')
  assert.equal(normalizeIndianMobileNumber('98765 43210'), '9876543210')
  assert.equal(normalizeIndianMobileNumber('+91 98765 43210'), '9876543210')
  assert.equal(normalizeIndianMobileNumber('91 98765 43210'), '9876543210')

  const parsed = reservationSchema.safeParse(validRequest)
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.customer.phone, '9876543210')
  assert.equal(parsed.data.customer.name, 'Test Customer')
  assert.equal(parsed.data.customer.address, '12, Main Road, Chennai, 600001, Tamil Nadu')
})

test('incomplete Indian mobile numbers and invalid characters are rejected', () => {
  for (const phone of ['91', '+91', '987654321', '1234567890', '98765abc210', '+1 9876543210']) {
    assert.equal(normalizeIndianMobileNumber(phone), null, phone)
    assert.equal(reservationSchema.safeParse({
      ...validRequest,
      customer: { ...validRequest.customer, phone },
    }).success, false, phone)
  }
})

test('server validation requires all customer address fields and a six-digit PIN', () => {
  for (const field of ['name', 'phone', 'doorNo', 'streetName', 'city', 'pincode', 'state']) {
    const customer = { ...validRequest.customer }
    delete customer[field]
    assert.equal(reservationSchema.safeParse({ ...validRequest, customer }).success, false, field)
  }
  for (const pincode of ['12345', '1234567', '12A456']) {
    assert.equal(reservationSchema.safeParse({
      ...validRequest,
      customer: { ...validRequest.customer, pincode },
    }).success, false, pincode)
  }
})

test('invalid API submissions are rejected before creating a reservation', async () => {
  let createCalls = 0
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body: {
      ...validRequest,
      customer: { ...validRequest.customer, pincode: '12345' },
    },
  }, response, {
    rateLimit: () => true,
    createReservation: async () => {
      createCalls += 1
      return {}
    },
  })

  assert.equal(response.statusCode, 400)
  assert.equal(createCalls, 0)
})

test('reservation API normalizes customer data before invoking the reservation service', async () => {
  let received
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body: validRequest,
  }, response, {
    rateLimit: () => true,
    createReservation: async (request) => {
      received = request
      return { reservationId: 'reservation-1', reservedQuantity: request.quantity }
    },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(received.customer.phone, '9876543210')
  assert.equal(received.customer.address, '12, Main Road, Chennai, 600001, Tamil Nadu')
  assert.equal(received.quantity, 3)
})

test('reservation API exposes idempotency conflicts so the client can safely retry changed payloads', async () => {
  const response = createResponse()
  await handler({
    method: 'POST',
    headers: {},
    body: validRequest,
  }, response, {
    rateLimit: () => true,
    createReservation: async () => {
      throw Object.assign(new Error('This idempotency key was already used for a different request.'), {
        code: 'IDEMPOTENCY_CONFLICT',
      })
    },
  })

  assert.equal(response.statusCode, 409)
  assert.equal(response.body.code, 'IDEMPOTENCY_CONFLICT')
})

test('reservation quantity validation rejects empty, zero, negative, decimal and non-numeric values', () => {
  for (const quantity of ['', '0', '-1', '1.5', 'abc']) {
    assert.ok(reservationQuantityError(quantity, 5))
    assert.equal(parseReservationQuantity(quantity, 5), null)
  }
  for (const quantity of ['1', '3', '5']) {
    assert.equal(parseReservationQuantity(quantity, 5), Number(quantity))
  }
  assert.match(reservationQuantityError('6', 5), /Only 5 item/)
  assert.equal(reservationSchema.safeParse({ ...validRequest, quantity: 0 }).success, false)
  assert.equal(reservationSchema.safeParse({ ...validRequest, quantity: 1.5 }).success, false)
})

test('QuickShop adds the selected product to cart without customer enquiry or reservation APIs', () => {
  const modal = readFileSync(new URL('../src/components/QuickShopModal.jsx', import.meta.url), 'utf8')
  assert.match(modal, /addToCart\(product\)/)
  assert.match(modal, /Stock is not reserved until you begin online checkout/)
  assert.doesNotMatch(modal, /createCheckoutReservation|createWhatsAppReservation|WhatsApp|customer details/)
})
