import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  completeOrderWhatsAppHandoff,
  completeOrderWhatsAppHandoffs,
  createOrderWhatsAppMessage,
  createOrderWhatsAppUrl,
  createVerifiedOrderWhatsAppUrl,
  createVerifiedOrdersWhatsAppUrl,
} from '../src/utils/whatsappOrder.js'
import { STORE_WHATSAPP_NUMBER } from '../src/config/storeContact.js'

const order = {
  paymentStatus: 'captured',
  orderStatus: 'confirmed',
  orderId: 'order-123',
  paymentId: 'pay-456',
  productId: 'product-123',
  customer: {
    name: 'Asha Customer',
    phone: '9876543210',
    doorNo: '12',
    streetName: 'Main Road',
    city: 'Chennai',
    pincode: '600001',
    state: 'Tamil Nadu',
    address: '12 Main Road, Chennai, 600001, Tamil Nadu',
  },
  productName: 'Silk Saree',
  quantity: 2,
  unitPrice: 2500,
  totalAmount: 5000,
}

const origin = 'http://localhost:3000'

test('message starts with the dynamic product URL and follows the requested confirmation format', () => {
  const message = createOrderWhatsAppMessage(order, origin)
  const lines = message.split('\n')
  const url = createOrderWhatsAppUrl('+442079460958', message)
  const parsed = new URL(url)

  assert.equal(lines[0], `${origin}/products/product-123`)
  assert.equal(lines[1], '')
  assert.equal(lines[2], 'GV Sarees order confirmation')
  assert.equal(lines[3], 'Order ID: order-123')
  assert.equal(parsed.hostname, 'wa.me')
  assert.equal(parsed.pathname, '/442079460958')
  assert.equal(parsed.searchParams.get('text'), message)
  assert.ok(url.includes('%0A'))
  assert.ok(url.includes('%E2%82%B9'))
  assert.ok(url.includes('%F0%9F%92%B3'))

  for (const value of [
    'Products:',
    'Silk Saree — Qty 2 × ₹2500',
    'Total amount: ₹5000',
    '💳 Payment Status: Paid',
    'Customer Details:',
    '👤 Name: Asha Customer',
    '📞 Phone: 9876543210',
    '📍 Address:',
    'Door No: 12',
    'Street: Main Road',
    'City: Chennai',
    'Pincode: 600001',
    'State: Tamil Nadu',
  ]) {
    assert.ok(message.includes(value), value)
  }
  assert.equal(message.includes(order.customer.address), false)
  assert.equal(message.includes('pay-456'), false)
  assert.equal(createOrderWhatsAppUrl('442079460958', message), '')
  assert.equal(createOrderWhatsAppUrl('+44 20 7946 0958', message), '')
})

test('each product in a multi-product order has one URL and one product detail entry', () => {
  const message = createOrderWhatsAppMessage({
    ...order,
    products: [
      { productId: 'silk/123', productName: 'Silk Saree', selectedSize: '5.5 m', quantity: 2, unitPrice: 2500 },
      { productId: 'cotton-456', productName: 'Cotton Saree', selectedSize: '6.3 m', quantity: 1, unitPrice: 1200 },
    ],
    totalAmount: 6200,
  }, 'https://shop.example')
  const lines = message.split('\n')

  assert.deepEqual(lines.slice(0, 2), [
    'https://shop.example/products/silk%2F123',
    'https://shop.example/products/cotton-456',
  ])
  assert.ok(message.includes('Silk Saree · Size 5.5 m — Qty 2 × ₹2500'))
  assert.ok(message.includes('Cotton Saree · Size 6.3 m — Qty 1 × ₹1200'))
  assert.ok(message.includes('Total amount: ₹6200'))
  assert.equal(message.split('Silk Saree · Size 5.5 m — Qty 2 × ₹2500').length - 1, 1)
  assert.equal(message.split('Cotton Saree · Size 6.3 m — Qty 1 × ₹1200').length - 1, 1)
})

test('unverified or unconfirmed payments never create a Paid message or WhatsApp URL', () => {
  for (const unverifiedOrder of [
    { ...order, paymentStatus: 'pending' },
    { ...order, paymentStatus: 'failed' },
    { ...order, orderStatus: 'initiated' },
    { ...order, paymentId: '' },
    { ...order, orderId: '   ' },
    { ...order, paymentId: '   ' },
  ]) {
    assert.equal(createOrderWhatsAppMessage(unverifiedOrder, origin), '')
    assert.equal(createVerifiedOrderWhatsAppUrl('+919876543210', unverifiedOrder, origin), '')
  }

  const verifiedUrl = createVerifiedOrderWhatsAppUrl('+919876543210', order, origin)
  assert.match(verifiedUrl, /^https:\/\/wa\.me\/919876543210\?text=/)
  assert.equal(createVerifiedOrderWhatsAppUrl('', order, origin), '')
})

test('missing optional address fields are omitted without repeating a combined address', () => {
  const message = createOrderWhatsAppMessage({
    ...order,
    customer: {
      name: 'Asha Customer',
      phone: '9876543210',
      doorNo: '12',
      city: 'Chennai',
      address: '12 Main Road, Chennai',
    },
  }, origin)

  assert.ok(message.includes('📍 Address:\nDoor No: 12\nCity: Chennai'))
  assert.equal(message.includes('Street:'), false)
  assert.equal(message.includes('Pincode:'), false)
  assert.equal(message.includes('State:'), false)
  assert.equal(message.includes('12 Main Road, Chennai'), false)

  const noAddress = createOrderWhatsAppMessage({
    ...order,
    customer: { name: 'Asha Customer', phone: '9876543210' },
  }, origin)
  assert.equal(noAddress.includes('📍 Address:'), false)
})

test('cart and Buy Now confirmation payloads use the matching product ID and shared message format', () => {
  const cartMessage = createOrderWhatsAppMessage({
    ...order,
    productId: 'cart-product',
    productName: 'Cart Silk Saree',
  }, origin)
  const buyNowMessage = createOrderWhatsAppMessage({
    ...order,
    productId: 'buy-now-product',
    productName: 'Buy Now Cotton Saree',
  }, origin)

  assert.ok(cartMessage.startsWith(`${origin}/products/cart-product`))
  assert.ok(cartMessage.includes('Cart Silk Saree — Qty 2 × ₹2500'))
  assert.ok(buyNowMessage.startsWith(`${origin}/products/buy-now-product`))
  assert.ok(buyNowMessage.includes('Buy Now Cotton Saree — Qty 2 × ₹2500'))

  const cartPage = readFileSync(new URL('../src/pages/CartPage.jsx', import.meta.url), 'utf8')
  assert.match(cartPage, /isBuyNowCheckout \? \(buyNowItem \? \[buyNowItem\] : \[\]\) : cartItems/)
  assert.match(cartPage, /products: confirmedItems/)
  assert.match(cartPage, /productId: confirmedItem\.productId \|\| confirmedItem\.id/)
  assert.match(cartPage, /totalAmount: Number\.isSafeInteger\(result\.paymentAmountPaise\)/)
  assert.match(cartPage, /completeOrderWhatsAppHandoff/)
  assert.match(cartPage, /completeOrderWhatsAppHandoffs\(confirmedOrders, getStoreSettings\)/)
  assert.match(cartPage, /Continue to WhatsApp to review order details/)
})

test('multi-item WhatsApp confirmation includes every product and the combined amount', () => {
  const message = createOrderWhatsAppMessage({
    ...order,
    products: [
      { productId: 'floral', productName: 'Floral Dola Silk Fancy Saree', quantity: 1, unitPrice: 2499 },
      { productId: 'mangalagiri', productName: 'Mangalagiri Handloom Cotton Saree', quantity: 1, unitPrice: 2899 },
    ],
    totalAmount: 5398,
  }, origin)

  assert.ok(message.includes('Floral Dola Silk Fancy Saree — Qty 1 × ₹2499'))
  assert.ok(message.includes('Mangalagiri Handloom Cotton Saree — Qty 1 × ₹2899'))
  assert.ok(message.includes('Total amount: ₹5398'))
})

test('verified order navigates in the current tab with a prefilled message', () => {
  const originalWindow = globalThis.window
  const navigations = []
  let popupCalls = 0
  globalThis.window = {
    location: {
      assign(url) {
        navigations.push(url)
      },
    },
    open() {
      popupCalls += 1
      return null
    },
  }

  try {
    const handoff = completeOrderWhatsAppHandoff('+919876543210', order, origin)
    assert.equal(handoff.opened, true)
    assert.deepEqual(navigations, [handoff.url])
    assert.match(handoff.url, /^https:\/\/wa\.me\/919876543210\?text=/)
    const message = new URL(handoff.url).searchParams.get('text')
    assert.ok(message.startsWith(`${origin}/products/product-123`))
    assert.ok(message.includes('Order ID: order-123'))
    assert.ok(message.includes('Silk Saree — Qty 2 × ₹2500'))
    assert.equal(popupCalls, 0)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('same-tab handoff rejects failed, pending, authorized, and unfulfilled payments', async () => {
  const redirectAttempts = []
  for (const unconfirmedOrder of [
    { ...order, paymentStatus: 'failed' },
    { ...order, paymentStatus: 'pending' },
    { ...order, paymentStatus: 'authorized' },
    { ...order, orderStatus: 'processing' },
    { ...order, orderStatus: 'initiated' },
    { ...order, orderId: '' },
    { ...order, paymentId: '' },
    { ...order, orderId: '   ' },
    { ...order, paymentId: '   ' },
  ]) {
    const directHandoff = completeOrderWhatsAppHandoff(
      '+919876543210',
      unconfirmedOrder,
      origin,
      (url) => redirectAttempts.push(url),
    )
    assert.deepEqual(directHandoff, { url: '', opened: false })

    const [batchHandoff] = await completeOrderWhatsAppHandoffs(
      [unconfirmedOrder],
      async () => ({ whatsappNumber: '+919876543210' }),
      (url) => redirectAttempts.push(url),
      origin,
    )
    assert.equal(batchHandoff.status, 'unavailable')
    assert.equal(batchHandoff.reason, 'unverified-order')
  }
  assert.deepEqual(redirectAttempts, [])
})

test('multiple confirmed orders use the existing message format in one same-tab handoff', async () => {
  const secondOrder = {
    ...order,
    orderId: 'order-456',
    productId: 'cotton-456',
    productName: 'Cotton Saree',
    paymentId: 'pay-789',
  }
  const url = createVerifiedOrdersWhatsAppUrl('+919876543210', [order, secondOrder], origin)
  const combinedMessage = new URL(url).searchParams.get('text')
  assert.ok(combinedMessage.includes('Order ID: order-123'))
  assert.ok(combinedMessage.includes('Order ID: order-456'))
  assert.equal(combinedMessage.split('GV Sarees order confirmation').length - 1, 2)

  const navigations = []
  const [first, second] = await completeOrderWhatsAppHandoffs(
    [order, secondOrder],
    async () => ({ whatsappNumber: '+919876543210' }),
    (target) => navigations.push(target),
    origin,
  )
  assert.deepEqual([first.status, second.status], ['opened', 'opened'])
  assert.deepEqual(navigations, [url])
})

test('settings failures and missing or invalid numbers return a same-tab retry URL', async () => {
  const navigations = []
  const [notConfigured] = await completeOrderWhatsAppHandoffs(
    [order],
    async () => ({ whatsappNumber: '' }),
    (url) => navigations.push(url),
  )
  const [invalidNumber] = await completeOrderWhatsAppHandoffs(
    [order],
    async () => ({ whatsappNumber: 'invalid' }),
    (url) => navigations.push(url),
  )
  const [settingsFailed] = await completeOrderWhatsAppHandoffs(
    [order],
    async () => { throw new Error('Settings endpoint unavailable.') },
    (url) => navigations.push(url),
  )

  for (const result of [notConfigured, invalidNumber, settingsFailed]) {
    assert.equal(result.status, 'fallback')
    assert.match(result.url, /^https:\/\/wa\.me\/919492766760\?text=/)
    assert.equal(new URL(result.url).pathname, `/${STORE_WHATSAPP_NUMBER.slice(1)}`)
    assert.ok(new URL(result.url).searchParams.get('text').includes('Order ID: order-123'))
  }
  assert.equal(notConfigured.reason, 'not-configured')
  assert.equal(invalidNumber.reason, 'invalid-number')
  assert.equal(settingsFailed.reason, 'settings-load-failed')
  assert.deepEqual(navigations, [])
  assert.deepEqual(order, {
    paymentStatus: 'captured',
    orderStatus: 'confirmed',
    orderId: 'order-123',
    paymentId: 'pay-456',
    productId: 'product-123',
    customer: order.customer,
    productName: 'Silk Saree',
    quantity: 2,
    unitPrice: 2500,
    totalAmount: 5000,
  })
})

test('a same-tab navigation error leaves a valid retry link', async () => {
  const [handoff] = await completeOrderWhatsAppHandoffs(
    [order],
    async () => ({ whatsappNumber: '+919876543210' }),
    () => { throw new Error('Navigation unavailable.') },
    origin,
  )

  assert.equal(handoff.status, 'fallback')
  assert.equal(handoff.reason, 'navigation-failed')
  assert.match(handoff.url, /^https:\/\/wa\.me\/919876543210\?text=/)
})

test('settings are fully loaded before navigation and an unencodable message fails with no redirect', async () => {
  const sequence = []
  const [handoff] = await completeOrderWhatsAppHandoffs(
    [order],
    async () => {
      sequence.push('settings-start')
      await Promise.resolve()
      sequence.push('settings-complete')
      return { whatsappNumber: '+919876543210' }
    },
    (url) => {
      sequence.push('navigate')
      assert.match(url, /^https:\/\/wa\.me\/919876543210\?text=/)
    },
    origin,
  )

  assert.deepEqual(sequence, ['settings-start', 'settings-complete', 'navigate'])
  assert.equal(handoff.status, 'opened')
  const unencodableOrder = {
    ...order,
    customer: { name: '\uD800' },
  }
  assert.equal(createVerifiedOrdersWhatsAppUrl('+919876543210', [unencodableOrder], origin), '')

  const [unavailable] = await completeOrderWhatsAppHandoffs(
    [unencodableOrder],
    async () => ({ whatsappNumber: '+919876543210' }),
    (url) => sequence.push(url),
    origin,
  )
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.reason, 'url-generation-failed')
  assert.deepEqual(sequence, ['settings-start', 'settings-complete', 'navigate'])
})

test('retry fallback in the cart is a same-tab link', () => {
  const cartPage = readFileSync(new URL('../src/pages/CartPage.jsx', import.meta.url), 'utf8')
  assert.match(cartPage, /orderWhatsAppLinks\.map\(\(\{ orderId, url \}\)/)
  assert.match(cartPage, /href=\{url\}/)
  assert.match(cartPage, /Continue to WhatsApp to review order details/)
  assert.doesNotMatch(cartPage, /Continue to WhatsApp[\s\S]{0,160}target="_blank"/)
})

test('WhatsApp checkout flow contains no popup or automatic-send behavior', () => {
  const cartPage = readFileSync(new URL('../src/pages/CartPage.jsx', import.meta.url), 'utf8')
  const razorpayService = readFileSync(new URL('../src/services/razorpayService.js', import.meta.url), 'utf8')
  const whatsappUtility = readFileSync(new URL('../src/utils/whatsappOrder.js', import.meta.url), 'utf8')

  assert.doesNotMatch(`${cartPage}\n${razorpayService}\n${whatsappUtility}`, /window\.open|about:blank|target="_blank"/)
  assert.match(cartPage, /Please review the pre-filled message and press Send/)
  assert.match(whatsappUtility, /window\.location\.assign\(url\)/)
  assert.doesNotMatch(whatsappUtility, /sendMessage|sendText|messages\.send/)
})
