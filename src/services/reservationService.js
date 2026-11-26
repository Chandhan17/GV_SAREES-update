import {
  buildCustomerAddress,
  normalizeCustomerSubmission,
} from '../../shared/customerValidation.js'

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function createChangedRequestKey(baseKey, payload) {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('Secure reservation key generation is unavailable.')
  }
  const customer = normalizeCustomerSubmission(payload.customer)
  const canonical = JSON.stringify({
    ...(Array.isArray(payload.items)
      ? {
        items: payload.items.map((item) => ({
          productId: String(item.productId),
          quantity: item.quantity,
          selectedSize: String(item.selectedSize || '').trim(),
        })),
      }
      : {
        productId: String(payload.productId),
        quantity: payload.quantity,
        selectedSize: String(payload.selectedSize || '').trim(),
      }),
    customer: {
      name: customer.name.trim().replace(/\s+/g, ' '),
      phone: customer.phone.replace(/\D/g, ''),
      address: buildCustomerAddress(customer).trim().replace(/\s+/g, ' '),
    },
  })
  const key = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(baseKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await cryptoApi.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonical),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const CUSTOMER_RESERVATION_PREFIX = 'gv-sarees-reservation:'
const CANCELLATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/i
const CHECKOUT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function createCheckoutIdempotencyKey() {
  return createIdempotencyKey()
}

async function postReservation(payload) {
  const response = await fetch('/api/reservations/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || 'Unable to reserve this product.')
    error.availableStock = body.details?.availableStock
    error.code = body.code
    throw error
  }
  return body.reservation
}

export async function createCheckoutReservation(payload) {
  const baseKey = payload.idempotencyKey || createIdempotencyKey()
  const request = { ...payload, idempotencyKey: baseKey }
  try {
    return await postReservation(request)
  } catch (error) {
    if (error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
    const changedKey = await createChangedRequestKey(baseKey, payload)
    if (changedKey === baseKey) throw error
    return postReservation({ ...request, idempotencyKey: changedKey })
  }
}

export function rememberCustomerReservation(reservation, checkoutIdempotencyKey) {
  const key = `${CUSTOMER_RESERVATION_PREFIX}${reservation.reservationId}`
  let savedCheckoutKey = ''
  if (!CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(checkoutIdempotencyKey || '')) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null')
      savedCheckoutKey = CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(saved?.checkoutIdempotencyKey || '')
        ? saved.checkoutIdempotencyKey
        : ''
    } catch {
      savedCheckoutKey = ''
    }
  }
  const checkoutKey = CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(checkoutIdempotencyKey || '')
    ? checkoutIdempotencyKey
    : savedCheckoutKey
  localStorage.setItem(key, JSON.stringify({
    reservationId: reservation.reservationId,
    cancellationToken: reservation.cancellationToken,
    expiresAt: reservation.expiresAt,
    productName: reservation.productName,
    reservedQuantity: reservation.reservedQuantity,
    ...(checkoutKey ? { checkoutIdempotencyKey: checkoutKey } : {}),
  }))
}

export function getCustomerReservationCheckoutKey(reservationId) {
  const raw = localStorage.getItem(`${CUSTOMER_RESERVATION_PREFIX}${reservationId}`)
  try {
    const saved = raw ? JSON.parse(raw) : null
    return CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(saved?.checkoutIdempotencyKey || '')
      ? saved.checkoutIdempotencyKey
      : ''
  } catch {
    return ''
  }
}

export function getCustomerReservations() {
  const reservations = []

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(CUSTOMER_RESERVATION_PREFIX)) continue

    const reservationId = key.slice(CUSTOMER_RESERVATION_PREFIX.length)
    const raw = localStorage.getItem(key)
    if (!raw) continue

    let saved
    try {
      saved = JSON.parse(raw)
    } catch {
      saved = null
    }

    reservations.push({
      reservationId,
      expiresAt: saved?.expiresAt || null,
      productName: typeof saved?.productName === 'string' ? saved.productName : '',
      reservedQuantity: Number.isInteger(saved?.reservedQuantity) ? saved.reservedQuantity : null,
      accessAvailable: saved?.reservationId === reservationId
        && CANCELLATION_TOKEN_PATTERN.test(saved?.cancellationToken || ''),
    })
  }

  return reservations
}

export async function getCustomerReservationStatusWithToken(reservationId, cancellationToken) {
  const response = await fetch('/api/reservations/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId, cancellationToken }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || 'Unable to retrieve reservation status.')
    error.status = response.status
    throw error
  }
  return body.reservation
}

export async function getCustomerReservationStatus(reservationId) {
  const key = `${CUSTOMER_RESERVATION_PREFIX}${reservationId}`
  const raw = localStorage.getItem(key)
  let saved
  try {
    saved = raw ? JSON.parse(raw) : null
  } catch {
    saved = null
  }
  if (!saved || saved.reservationId !== reservationId || !CANCELLATION_TOKEN_PATTERN.test(saved.cancellationToken || '')) {
    throw new Error('Reservation access details are unavailable on this device.')
  }
  return getCustomerReservationStatusWithToken(reservationId, saved.cancellationToken)
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
