export function getOrderReservedQuantity(order) {
  return Number.isSafeInteger(order?.reservedQuantity) && order.reservedQuantity > 0
    ? order.reservedQuantity
    : null
}

export function getOrderItems(order) {
  const storedItems = [order?.items, order?.orderItems, order?.products]
    .find((value) => Array.isArray(value) && value.length)
  if (storedItems) {
    return storedItems
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        productId: item.productId || item.id || '',
        productName: item.productName || item.name || '',
        image: item.image || '',
        selectedSize: item.selectedSize || item.sizeLength || '',
        quantity: Number.isInteger(item.quantity ?? item.reservedQuantity)
          ? item.quantity ?? item.reservedQuantity
          : 0,
        price: Number(item.price ?? item.unitPrice) || 0,
      }))
  }
  if (!order) return []
  return [{
    productId: order.productId || '',
    productName: order.productName || '',
    image: order.image || '',
    selectedSize: order.selectedSize || '',
    quantity: Number.isInteger(order.reservedQuantity ?? order.quantity)
      ? order.reservedQuantity ?? order.quantity
      : 0,
    price: Number(order.price ?? order.unitPrice) || 0,
  }]
}

export function getOrderTotal(order) {
  const savedTotal = Number(order?.totalAmount ?? order?.subtotal)
  if (Number.isFinite(savedTotal) && savedTotal >= 0) return savedTotal
  return getOrderItems(order).reduce((total, item) => total + item.quantity * item.price, 0)
}
