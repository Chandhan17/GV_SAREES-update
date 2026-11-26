import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeProductUpdate, saveProductUpdate } from '../src/utils/productUpdate.js'

const originalProduct = {
  id: 'product-1',
  name: 'Original name',
  description: 'Original description',
  price: 100,
  totalStock: 8,
  lowStockThreshold: 2,
  reservedStock: 1,
  availableStock: 7,
}

for (const [field, value] of [
  ['name', 'Updated name'],
  ['description', 'Updated description'],
  ['price', 125],
]) {
  test(`${field}-only update skips the inventory service`, async () => {
    let inventoryCalls = 0
    let productCalls = 0

    await saveProductUpdate({
      productId: originalProduct.id,
      originalProduct,
      quantityChange: undefined,
      lowStockThreshold: originalProduct.lowStockThreshold,
      payload: { [field]: value },
      adjustInventory: async () => { inventoryCalls += 1 },
      persistProduct: async () => { productCalls += 1 },
    })

    assert.equal(inventoryCalls, 0)
    assert.equal(productCalls, 1)
  })
}

test('stock changes still use the inventory service before saving product fields', async () => {
  const calls = []

  await saveProductUpdate({
    productId: originalProduct.id,
    originalProduct,
    quantityChange: 3,
    lowStockThreshold: originalProduct.lowStockThreshold,
    payload: { name: 'Updated name' },
    adjustInventory: async (request) => {
      calls.push(['inventory', request])
      return { totalStock: 11, reservedStock: 1, availableStock: 10, lowStockThreshold: 2 }
    },
    persistProduct: async () => { calls.push(['product']) },
  })

  assert.deepEqual(calls, [
    ['inventory', {
      productId: originalProduct.id,
      quantityChange: 3,
      lowStockThreshold: 2,
      reason: 'Manual admin stock adjustment',
    }],
    ['product'],
  ])
})

test('threshold changes still use the inventory service', async () => {
  let inventoryRequest

  await saveProductUpdate({
    productId: originalProduct.id,
    originalProduct,
    quantityChange: undefined,
    lowStockThreshold: 4,
    payload: { name: 'Updated name' },
    adjustInventory: async (request) => {
      inventoryRequest = request
      return { totalStock: 8, reservedStock: 1, availableStock: 7, lowStockThreshold: 4 }
    },
    persistProduct: async () => {},
  })

  assert.deepEqual(inventoryRequest, {
    productId: originalProduct.id,
    quantityChange: undefined,
    lowStockThreshold: 4,
    reason: 'Update low-stock threshold',
  })
})

test('product write failure rejects without invoking the save-success callback', async () => {
  let saved = false

  await assert.rejects(saveProductUpdate({
    productId: originalProduct.id,
    originalProduct,
    quantityChange: undefined,
    lowStockThreshold: originalProduct.lowStockThreshold,
    payload: { name: 'Updated name' },
    adjustInventory: async () => {},
    persistProduct: async () => { throw new Error('write failed') },
    onSaved: () => { saved = true },
  }), /write failed/)

  assert.equal(saved, false)
})

test('inventory failure prevents product persistence and save-success notification', async () => {
  let inventoryUpdated = false
  let productPersisted = false
  let saved = false

  await assert.rejects(saveProductUpdate({
    productId: originalProduct.id,
    originalProduct,
    quantityChange: 2,
    lowStockThreshold: originalProduct.lowStockThreshold,
    payload: { name: 'Updated name' },
    adjustInventory: async () => { throw new Error('inventory failed') },
    persistProduct: async () => { productPersisted = true },
    onInventoryUpdated: () => { inventoryUpdated = true },
    onSaved: () => { saved = true },
  }), /inventory failed/)

  assert.equal(inventoryUpdated, false)
  assert.equal(productPersisted, false)
  assert.equal(saved, false)
})

test('successful updates invoke the save-success callback after the product write', async () => {
  const calls = []

  await saveProductUpdate({
    productId: originalProduct.id,
    originalProduct,
    quantityChange: undefined,
    lowStockThreshold: originalProduct.lowStockThreshold,
    payload: { name: 'Updated name' },
    adjustInventory: async () => {},
    persistProduct: async () => { calls.push('product-write') },
    onSaved: () => { calls.push('success') },
  })

  assert.deepEqual(calls, ['product-write', 'success'])
})

test('local product update merges saved fields without replacing unrelated inventory or products', () => {
  const otherProduct = { id: 'product-2', name: 'Other product' }
  const updatedProducts = mergeProductUpdate(
    [originalProduct, otherProduct],
    originalProduct.id,
    { name: 'Updated name', price: 125 },
    { totalStock: 10, reservedStock: 1, availableStock: 9, lowStockThreshold: 3 },
  )

  assert.deepEqual(updatedProducts[0], {
    ...originalProduct,
    name: 'Updated name',
    price: 125,
    totalStock: 10,
    reservedStock: 1,
    availableStock: 9,
    lowStockThreshold: 3,
  })
  assert.equal(updatedProducts[1], otherProduct)
})
