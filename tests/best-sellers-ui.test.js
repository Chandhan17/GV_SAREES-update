import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectAvailableBestSellers,
  shouldShowBestSellers,
} from '../src/utils/bestSellers.js'

test('preserves ranking order, excludes unavailable products, and limits the homepage to six', () => {
  const products = Array.from({ length: 8 }, (_, index) => ({
    id: `product-${index}`,
    availableStock: index === 1 ? 0 : 1,
  }))

  assert.deepEqual(
    selectAvailableBestSellers(products.map(({ id }) => id), products).map(({ id }) => id),
    ['product-0', 'product-2', 'product-3', 'product-4', 'product-5', 'product-6'],
  )
})

test('hides the Best Sellers section after a successful no-sales response', () => {
  assert.equal(shouldShowBestSellers({
    productsLoading: false,
    bestSellersLoading: false,
    error: '',
    productCount: 0,
  }), false)
})

test('keeps the section visible while loading or showing a retryable error', () => {
  assert.equal(shouldShowBestSellers({
    productsLoading: true,
    bestSellersLoading: false,
    error: '',
    productCount: 0,
  }), true)
  assert.equal(shouldShowBestSellers({
    productsLoading: false,
    bestSellersLoading: false,
    error: 'Request failed',
    productCount: 0,
  }), true)
})
