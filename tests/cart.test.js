import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  addCartProduct,
  BUY_NOW_STORAGE_KEY,
  CART_STORAGE_KEY,
  clearCartItems,
  createBuyNowCartItem,
  getCartAvailabilityErrors,
  getCartItemCount,
  getCartSubtotal,
  readBuyNowItem,
  readCartItems,
  removeCartProduct,
  setCartProductQuantity,
  writeBuyNowItem,
  writeCartItems,
} from '../src/utils/cart.js'

function createStorage() {
  const entries = new Map()
  return {
    getItem(key) {
      return entries.get(key) || null
    },
    setItem(key, value) {
      entries.set(key, String(value))
    },
    removeItem(key) {
      entries.delete(key)
    },
  }
}

const product = {
  id: 'product-1',
  name: 'Test saree',
  price: 2500,
  images: [{ url: '/saree.jpg' }],
  sizeLength: '5.5 m',
  availableStock: 5,
  totalStock: 5,
  reservedStock: 0,
}

test('adding a product creates one cart line without changing inventory', () => {
  const items = addCartProduct([], product)
  assert.equal(items.length, 1)
  assert.equal(items[0].quantity, 1)
  assert.equal(items[0].id, product.id)
  assert.equal(items[0].image, '/saree.jpg')
  assert.deepEqual([product.totalStock, product.reservedStock, product.availableStock], [5, 0, 5])
})

test('adding an existing product increases its cart quantity without creating duplicate lines', () => {
  const once = addCartProduct([], product)
  const twice = addCartProduct(once, product)
  assert.equal(twice.length, 1)
  assert.equal(twice[0].quantity, 2)
  assert.equal(getCartItemCount(twice), 2)
})

test('adding a selected quantity creates or increments one cart line without reserving inventory', () => {
  const selectedQuantity = addCartProduct([], product, 3)
  const combinedQuantity = addCartProduct(selectedQuantity, product, 2)

  assert.equal(selectedQuantity[0].quantity, 3)
  assert.equal(combinedQuantity.length, 1)
  assert.equal(combinedQuantity[0].quantity, 5)
  assert.throws(() => addCartProduct([], product, 0), /positive whole number/)
  assert.throws(() => addCartProduct([], product, 6), /Only 5 item/)
  assert.deepEqual([product.totalStock, product.reservedStock, product.availableStock], [5, 0, 5])
})

test('cart quantity can increase and decrease while rejecting invalid quantities', () => {
  const items = addCartProduct([], product)
  const increased = setCartProductQuantity(items, product.id, 3, 5)
  const decreased = setCartProductQuantity(increased, product.id, 1, 5)

  assert.equal(increased[0].quantity, 3)
  assert.equal(decreased[0].quantity, 1)
  assert.throws(() => setCartProductQuantity(items, product.id, 6, 5), /Only 5 item/)
  assert.throws(() => setCartProductQuantity(items, product.id, 0, 5), /positive whole number/)
})

test('cart removes individual products and clears all items', () => {
  const twoProducts = addCartProduct(addCartProduct([], product), { ...product, id: 'product-2', name: 'Second saree' })
  assert.equal(removeCartProduct(twoProducts, product.id).length, 1)
  assert.deepEqual(clearCartItems(), [])
})

test('subtotal uses current catalogue price and persisted cart survives a reload', () => {
  const items = setCartProductQuantity(addCartProduct([], product), product.id, 3, 5)
  const currentProducts = new Map([[product.id, { ...product, price: 3000 }]])
  assert.equal(getCartSubtotal(items, currentProducts), 9000)

  const storage = createStorage()
  writeCartItems(items, storage)
  const reloadedItems = readCartItems(storage)
  assert.equal(storage.getItem(CART_STORAGE_KEY) !== null, true)
  assert.equal(reloadedItems[0].id, product.id)
  assert.equal(reloadedItems[0].quantity, 3)
  assert.equal(reloadedItems[0].reservationKey, items[0].reservationKey)
  assert.equal(getCartItemCount(reloadedItems), 3)
})

test('Buy Now validates and persists its selected quantity separately from the saved cart', () => {
  const storage = createStorage()
  const savedCart = addCartProduct([], product)
  writeCartItems(savedCart, storage)

  const buyNowItem = createBuyNowCartItem(product, 3)
  writeBuyNowItem(buyNowItem, storage)

  assert.equal(BUY_NOW_STORAGE_KEY !== CART_STORAGE_KEY, true)
  assert.equal(readCartItems(storage)[0].quantity, 1)
  assert.equal(readBuyNowItem(storage).id, product.id)
  assert.equal(readBuyNowItem(storage).quantity, 3)
  assert.equal(product.reservedStock, 0)
  assert.throws(() => createBuyNowCartItem({ ...product, availableStock: 0 }), /out of stock/)
  assert.throws(() => createBuyNowCartItem(product, 0), /positive whole number/)
  assert.throws(() => createBuyNowCartItem(product, 6), /Only 5 item/)

  writeBuyNowItem(null, storage)
  assert.equal(readBuyNowItem(storage), null)
  assert.equal(readCartItems(storage)[0].id, product.id)
})

test('unavailable or deleted products block checkout and cannot be newly added', () => {
  const items = addCartProduct([], product)
  assert.equal(getCartAvailabilityErrors(items, [{ ...product, availableStock: 0 }])[0].productId, product.id)
  assert.match(getCartAvailabilityErrors(items, [])[0].message, /no longer available/)
  assert.throws(() => addCartProduct([], { ...product, availableStock: 0 }), /out of stock/)
  assert.deepEqual([product.totalStock, product.reservedStock, product.availableStock], [5, 0, 5])
})

test('cart route uses online checkout only and product actions do not reserve inventory', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const navbar = readFileSync(new URL('../src/components/Navbar.jsx', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../src/components/ProductCard.jsx', import.meta.url), 'utf8')
  const cartPage = readFileSync(new URL('../src/pages/CartPage.jsx', import.meta.url), 'utf8')
  const homePage = readFileSync(new URL('../src/pages/HomePage.jsx', import.meta.url), 'utf8')
  const productsPage = readFileSync(new URL('../src/pages/ProductsPage.jsx', import.meta.url), 'utf8')
  const addToCartHandler = homePage.match(/const handleAddToCart = \(product\) => \{[\s\S]*?\n {2}\}/)?.[0]

  assert.match(app, /path="\/cart"/)
  assert.match(navbar, /to="\/cart"/)
  assert.match(navbar, /itemCount/)
  assert.match(card, /onAddToCart\?\.\(product\)/)
  assert.ok(addToCartHandler)
  assert.doesNotMatch(addToCartHandler, /navigate|startBuyNow/)
  assert.match(card, /await onBuyNow\(product\)/)
  assert.match(card, /buyNowLockRef\.current \|\| !onBuyNow/)
  assert.match(homePage, /startBuyNow\(product, 1\)/)
  assert.match(homePage, /navigate\('\/cart\?mode=buy-now'\)/)
  assert.match(productsPage, /navigate\('\/cart\?mode=buy-now'\)/)
  assert.match(cartPage, /const items = isBuyNowCheckout \? \(buyNowItem \? \[buyNowItem\] : \[\]\) : cartItems/)
  assert.match(cartPage, /Your saved cart is unchanged/)
  assert.match(cartPage, /getCartAvailabilityErrors/)
  assert.match(cartPage, /createCheckoutReservation/)
  assert.match(cartPage, /checkoutReservation/)
  assert.doesNotMatch(cartPage, /createWhatsAppReservation|Reserve & enquire|openWhatsApp/)
  assert.match(cartPage, /WhatsApp is not used to complete your order|Order confirmed/)
  assert.match(cartPage, /disabled={!isCheckoutValid}/)
  assert.match(cartPage, /After successful online payment, your order will be forwarded to WhatsApp for confirmation/)
  assert.match(cartPage, /Please review the pre-filled message and press Send/)
  assert.match(cartPage, /The configured store WhatsApp number is missing or invalid/)
  assert.match(cartPage, /Store WhatsApp settings could not be loaded/)
  assert.match(cartPage, /url-generation-failed/)
})

test('cart success requires a confirmed server result before same-tab WhatsApp handoff', () => {
  const cartPage = readFileSync(new URL('../src/pages/CartPage.jsx', import.meta.url), 'utf8')
  const confirmedBranchStart = cartPage.indexOf('if (isConfirmedCheckoutResult(result)) {')
  const confirmedBranchEnd = cartPage.indexOf('\n        } else {', confirmedBranchStart)
  const confirmedBranch = cartPage.slice(confirmedBranchStart, confirmedBranchEnd)

  assert.ok(confirmedBranchStart >= 0 && confirmedBranchEnd > confirmedBranchStart)
  assert.match(confirmedBranch, /isConfirmedCheckoutResult\(result\)/)
  assert.match(confirmedBranch, /products: confirmedItems/)
  assert.match(confirmedBranch, /clearCheckout\(\)/)
  assert.match(confirmedBranch, /setConfirmedOrderSummary/)
  assert.match(confirmedBranch, /setCheckoutMessageTone\('success'\)/)
  assert.match(confirmedBranch, /success\('Payment captured and order confirmed\.'\)/)
  assert.ok(confirmedBranch.indexOf('isConfirmedCheckoutResult(result)') < confirmedBranch.indexOf('clearCheckout()'))
  assert.match(cartPage, /await completeOrderWhatsAppHandoffs\(confirmedOrders, getStoreSettings\)/)
  assert.doesNotMatch(cartPage, /window\.open|about:blank|target="_blank"/)
  assert.match(cartPage, /items: checkoutItems/)
  assert.doesNotMatch(cartPage, /for \(const item of \[\.\.\.items\]\)/)
  assert.match(cartPage, /confirmedOrderSummary\.products\.map/)
  assert.match(cartPage, /Total: \{formatINR\(confirmedOrderSummary\.totalAmount\)\}/)
  assert.ok(
    cartPage.indexOf("success('Payment captured and order confirmed.')")
      < cartPage.indexOf('await completeOrderWhatsAppHandoffs(confirmedOrders, getStoreSettings)'),
  )
  assert.doesNotMatch(cartPage, /window\.open|about:blank|target="_blank"|pendingWhatsAppWindow/)
  assert.doesNotMatch(cartPage, /Continue to WhatsApp[\s\S]{0,100}target="_blank"/)
  assert.ok(cartPage.includes('Payment authorized and awaiting capture'))
  assert.ok(cartPage.includes('Payment is still pending'))
  assert.ok(cartPage.includes('Payment was captured, but order fulfillment is still being reconciled'))
})
