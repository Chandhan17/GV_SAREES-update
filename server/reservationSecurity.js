import { Buffer } from 'node:buffer'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function normalizeCustomer(customer = {}) {
  return {
    name: String(customer.name || '').trim().replace(/\s+/g, ' '),
    phone: String(customer.phone || '').replace(/\D/g, ''),
    address: String(customer.address || '').trim().replace(/\s+/g, ' '),
  }
}

export function reservationFingerprint({ productId, quantity, selectedSize, customer }) {
  const canonical = JSON.stringify({
    productId: String(productId),
    quantity,
    selectedSize: String(selectedSize || '').trim(),
    customer: normalizeCustomer(customer),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function makeCancellationToken(secret, reservationId, fingerprint) {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('RESERVATION_TOKEN_SECRET must contain at least 32 bytes.')
  }
  return createHmac('sha256', secret)
    .update(`${reservationId}:${fingerprint}`)
    .digest('hex')
}

export function hashCancellationToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function cancellationTokenMatches(token, expectedHash) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return false
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false
  const actual = Buffer.from(hashCancellationToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return timingSafeEqual(actual, expected)
}

export function idempotencyKeyIsValid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

export function isReservationExpired(expiresAt, now = Date.now()) {
  const expiryMillis = typeof expiresAt?.toMillis === 'function'
    ? expiresAt.toMillis()
    : typeof expiresAt?.toDate === 'function'
      ? expiresAt.toDate().getTime()
      : expiresAt instanceof Date
        ? expiresAt.getTime()
        : Date.parse(expiresAt)
  const nowMillis = typeof now === 'number' ? now : now?.toMillis?.() ?? now?.getTime?.()
  return Number.isFinite(expiryMillis) && Number.isFinite(nowMillis) && expiryMillis <= nowMillis
}
