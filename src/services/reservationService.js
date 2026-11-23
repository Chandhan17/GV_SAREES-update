function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function createWhatsAppReservation(payload) {
  const response = await fetch('/api/reservations/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, idempotencyKey: payload.idempotencyKey || createIdempotencyKey() }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || 'Unable to reserve this product.')
    error.availableStock = body.details?.availableStock
    throw error
  }
  return body.reservation
}

export function rememberCustomerReservation(reservation) {
  const key = `gv-sarees-reservation:${reservation.reservationId}`
  localStorage.setItem(key, JSON.stringify({
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    expiresAt: reservation.expiresAt,
  }))
}

export async function cancelWhatsAppReservation(reservationId) {
  const key = `gv-sarees-reservation:${reservationId}`
  const raw = localStorage.getItem(key)
  let saved
  try {
    saved = raw ? JSON.parse(raw) : null
  } catch {
    saved = null
  }
  if (!saved || saved.reservationId !== reservationId || typeof saved.cancellationToken !== 'string') {
    throw new Error('Cancellation details for this reservation are unavailable on this device.')
  }
  const response = await fetch('/api/reservations/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId, cancellationToken: saved.cancellationToken }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to cancel reservation.')
  localStorage.removeItem(key)
  return body
}

export async function adminReservationAction({ action, reservationId, reason }) {
  const { getIdToken } = await import('./authService')
  const token = await getIdToken()
  const response = await fetch('/api/admin/reservations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, reservationId, reason }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to update reservation.')
  return body
}

export async function adjustProductInventory({ productId, quantityChange, lowStockThreshold, reason }) {
  const { getIdToken } = await import('./authService')
  const token = await getIdToken()
  const response = await fetch('/api/admin/inventory', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      action: quantityChange === undefined ? 'set-threshold' : 'adjust',
      productId,
      quantityChange,
      lowStockThreshold,
      reason,
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to update inventory.')
  return body.inventory
}
