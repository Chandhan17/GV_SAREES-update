import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { getOrderItems, getOrderReservedQuantity, getOrderTotal } from '../src/utils/orderPresentation.js'

test('admin quantity display uses the persisted reservedQuantity field', () => {
  assert.equal(getOrderReservedQuantity({ reservedQuantity: 3 }), 3)
  assert.equal(getOrderReservedQuantity({ reservedQuantity: 1 }), 1)

  const dashboard = readFileSync(new URL('../src/pages/AdminOrders.jsx', import.meta.url), 'utf8')
  const orderService = readFileSync(new URL('../src/services/orderService.js', import.meta.url), 'utf8')

  assert.match(dashboard, /getOrderReservedQuantity\(order\)/)
  assert.match(orderService, /id: snapshot\.id,\s*\.\.\.data/)
})

test('legacy orders without a valid reservedQuantity do not receive an invented value', () => {
  assert.equal(getOrderReservedQuantity({}), null)
  assert.equal(getOrderReservedQuantity({ reservedQuantity: 0 }), null)
  assert.equal(getOrderReservedQuantity({ reservedQuantity: 1.5 }), null)
  assert.equal(getOrderReservedQuantity(null), null)
})

test('multi-item admin presentation includes each product and the complete order total', () => {
  const order = {
    items: [
      { productId: 'floral', productName: 'Floral Dola Silk Fancy Saree', image: 'floral.jpg', selectedSize: '5.5 m', quantity: 1, price: 2499 },
      { productId: 'mangalagiri', productName: 'Mangalagiri Handloom Cotton Saree', image: 'mangalagiri.jpg', selectedSize: '6.3 m', quantity: 1, price: 2899 },
    ],
    totalAmount: 5398,
  }
  const items = getOrderItems(order)
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.productName), [
    'Floral Dola Silk Fancy Saree',
    'Mangalagiri Handloom Cotton Saree',
  ])
  assert.deepEqual(items.map((item) => item.image), ['floral.jpg', 'mangalagiri.jpg'])
  assert.equal(getOrderTotal(order), 5398)
  assert.equal(getOrderTotal({ productName: 'Historical saree', price: 1200, reservedQuantity: 2 }), 2400)

  const ordersPage = readFileSync(new URL('../src/pages/AdminOrders.jsx', import.meta.url), 'utf8')
  const dashboardPage = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  assert.match(ordersPage, /orderItems\.map/)
  assert.match(ordersPage, /getOrderItems\(viewingOrder\)\.map/)
  assert.match(ordersPage, /Date &amp; time \(IST\)/)
  assert.match(ordersPage, /Object\.values\(viewingOrder\.paymentAttempts\)/)
  assert.match(dashboardPage, /getOrderItems\(order\)\.map/)
  assert.match(dashboardPage, /formatStoreDateTime/)
})
