export function normalizeInventory(data = {}) {
  const totalStock = Math.max(0, Number.isInteger(data.totalStock) ? data.totalStock : 0)
  const reservedStock = Math.max(0, Number.isInteger(data.reservedStock) ? data.reservedStock : 0)
  const lowStockThreshold = Math.max(0, Number.isInteger(data.lowStockThreshold) ? data.lowStockThreshold : 2)

  return {
    totalStock,
    reservedStock: Math.min(reservedStock, totalStock),
    availableStock: Math.max(0, totalStock - reservedStock),
    inStock: totalStock - reservedStock > 0,
    lowStockThreshold,
  }
}

export function assertQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    const error = new Error('Quantity must be a positive integer.')
    error.code = 'INVALID_QUANTITY'
    throw error
  }
}

export function reserveInventory(data, quantity) {
  assertQuantity(quantity)
  const inventory = normalizeInventory(data)
  if (inventory.availableStock < quantity) {
    const error = new Error(`Only ${inventory.availableStock} item(s) are available.`)
    error.code = 'INSUFFICIENT_STOCK'
    error.availableStock = inventory.availableStock
    throw error
  }
  return normalizeInventory({
    ...inventory,
    reservedStock: inventory.reservedStock + quantity,
  })
}

export function releaseInventory(data, quantity) {
  assertQuantity(quantity)
  const inventory = normalizeInventory(data)
  return normalizeInventory({
    ...inventory,
    reservedStock: Math.max(0, inventory.reservedStock - quantity),
  })
}

export function convertInventory(data, quantity) {
  assertQuantity(quantity)
  const inventory = normalizeInventory(data)
  if (inventory.reservedStock < quantity) {
    const error = new Error('Reservation quantity is not currently reserved.')
    error.code = 'RESERVATION_MISMATCH'
    throw error
  }
  return normalizeInventory({
    ...inventory,
    totalStock: inventory.totalStock - quantity,
    reservedStock: inventory.reservedStock - quantity,
  })
}

function assertLowStockThreshold(lowStockThreshold) {
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
    const error = new Error('Low-stock threshold must be a non-negative integer.')
    error.code = 'INVALID_LOW_STOCK_THRESHOLD'
    throw error
  }
}

export function setInventoryThreshold(data, lowStockThreshold) {
  assertLowStockThreshold(lowStockThreshold)
  return normalizeInventory({ ...data, lowStockThreshold })
}

export function adjustInventory(data, quantityChange, lowStockThreshold) {
  if (lowStockThreshold !== undefined) assertLowStockThreshold(lowStockThreshold)
  if (!Number.isInteger(quantityChange) || quantityChange === 0) {
    const error = new Error('Stock adjustment must be a non-zero integer.')
    error.code = 'INVALID_ADJUSTMENT'
    throw error
  }
  const inventory = normalizeInventory(data)
  const nextTotal = inventory.totalStock + quantityChange
  if (nextTotal < inventory.reservedStock) {
    const error = new Error(`Stock cannot be reduced below ${inventory.reservedStock} reserved item(s).`)
    error.code = 'RESERVED_STOCK_PROTECTED'
    throw error
  }
  return normalizeInventory({
    ...inventory,
    totalStock: nextTotal,
    ...(lowStockThreshold !== undefined ? { lowStockThreshold } : {}),
  })
}
