export function applyReservationRestock(orders, restockResult) {
  if (
    restockResult?.success !== true ||
    !restockResult.orderId ||
    restockResult.status !== 'restocked' ||
    restockResult.orderStatus !== 'cancelled' ||
    restockResult.reservationStatus !== 'converted' ||
    restockResult.stockRestored !== true
  ) {
    return orders
  }

  return orders.map((order) => order.id === restockResult.orderId
    ? {
        ...order,
        orderStatus: restockResult.orderStatus,
        reservationStatus: restockResult.reservationStatus,
        stockRestored: restockResult.stockRestored,
        stockRestoredAt: restockResult.stockRestoredAt || order.stockRestoredAt || null,
      }
    : order)
}

export function getDisplayedOrderStatus(order) {
  return typeof order?.orderStatus === 'string' && order.orderStatus
    ? order.orderStatus
    : 'initiated'
}
