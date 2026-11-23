const ORDER_STATUSES = new Set(['initiated', 'confirmed', 'completed'])

export function validateOrderStatusTransition(order, nextStatus) {
  if (!ORDER_STATUSES.has(nextStatus)) {
    throw Object.assign(new Error('Unsupported order status.'), { code: 'INVALID_ORDER_STATUS' })
  }

  if (order.reservationId) {
    if (nextStatus === 'confirmed') {
      throw Object.assign(new Error('Confirm reservations through the reservation workflow.'), { code: 'RESERVATION_ACTION_REQUIRED' })
    }
    if (nextStatus === 'completed' && order.reservationStatus !== 'converted') {
      throw Object.assign(new Error('Only converted reservations can be completed.'), { code: 'RESERVATION_NOT_CONVERTED' })
    }
    if (nextStatus === 'initiated' && order.reservationStatus !== 'active') {
      throw Object.assign(new Error('Released or expired reservations cannot be reopened.'), { code: 'RESERVATION_NOT_ACTIVE' })
    }
    if (nextStatus === 'completed' && order.orderStatus !== 'confirmed') {
      throw Object.assign(new Error('Only confirmed orders can be completed.'), { code: 'INVALID_ORDER_TRANSITION' })
    }
  }
}

export function assertOrderCanArchive(order) {
  if (order.reservationStatus === 'active') {
    throw Object.assign(new Error('Release or resolve the active reservation before archiving this order.'), { code: 'ACTIVE_RESERVATION' })
  }
}
