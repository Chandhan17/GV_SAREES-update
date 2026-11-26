export function logProductUpdateTiming(operation, startedAt, outcome) {
  console.info('[admin-product-update-timing]', {
    operation,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    outcome,
  })
}

export async function saveProductUpdate({
  productId,
  originalProduct,
  quantityChange,
  lowStockThreshold,
  payload,
  adjustInventory,
  persistProduct,
  onInventoryUpdated,
  onSaved,
}) {
  const originalTotalStock = Number.isInteger(originalProduct?.totalStock)
    ? Math.max(0, originalProduct.totalStock)
    : 0
  const originalThreshold = Number.isInteger(originalProduct?.lowStockThreshold)
    ? Math.max(0, originalProduct.lowStockThreshold)
    : 2
  const submittedTotalStock = originalTotalStock + (quantityChange ?? 0)
  const submittedThreshold = Number(lowStockThreshold)
  const inventoryChanged = !originalProduct
    || submittedTotalStock !== originalTotalStock
    || submittedThreshold !== originalThreshold

  let inventory
  if (inventoryChanged) {
    const inventoryStartedAt = performance.now()
    try {
      inventory = await adjustInventory({
        productId,
        quantityChange,
        lowStockThreshold: submittedThreshold,
        reason: quantityChange !== undefined
          ? 'Manual admin stock adjustment'
          : 'Update low-stock threshold',
      })
    } catch (error) {
      logProductUpdateTiming('inventory-update-request', inventoryStartedAt, 'failure')
      throw error
    }
    logProductUpdateTiming('inventory-update-request', inventoryStartedAt, 'success')
    onInventoryUpdated?.(inventory)
  }

  const productStartedAt = performance.now()
  try {
    await persistProduct(productId, payload)
  } catch (error) {
    logProductUpdateTiming('product-update-request', productStartedAt, 'failure')
    throw error
  }
  logProductUpdateTiming('product-update-request', productStartedAt, 'success')
  onSaved?.()

  return inventory
}

export function mergeProductUpdate(products, productId, payload, inventory) {
  return products.map((product) => (
    product.id === productId
      ? { ...product, ...payload, ...(inventory || {}) }
      : product
  ))
}
