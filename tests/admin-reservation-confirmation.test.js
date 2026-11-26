import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { adminReservationSchema } from '../server/validation.js'
import { validateOrderStatusTransition } from '../server/orderPolicy.js'
import {
  applyReservationRestock,
  getDisplayedOrderStatus,
} from '../src/utils/reservationOrderState.js'

test('admin reservation actions do not expose manual order confirmation', () => {
  assert.equal(adminReservationSchema.safeParse({
    action: 'confirm',
    reservationId: 'reservation-1',
  }).success, false)
  assert.throws(
    () => validateOrderStatusTransition({ orderStatus: 'initiated', paymentStatus: 'pending' }, 'confirmed'),
    { code: 'AUTOMATIC_CONFIRMATION_REQUIRED' },
  )

  const api = readFileSync(new URL('../api/admin/orders.js', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /confirmReservation/)
})

test('restock response updates the historical order without deleting it', () => {
  const order = {
    id: 'order-1',
    orderStatus: 'confirmed',
    reservationStatus: 'converted',
    stockDeducted: true,
    stockRestored: false,
    paymentStatus: 'pending',
  }
  const updated = applyReservationRestock([order], {
    success: true,
    status: 'restocked',
    orderId: 'order-1',
    orderStatus: 'cancelled',
    reservationStatus: 'converted',
    stockRestored: true,
    stockRestoredAt: '2026-11-23T12:00:00.000Z',
  })

  assert.equal(updated.length, 1)
  assert.equal(updated[0].orderStatus, 'cancelled')
  assert.equal(getDisplayedOrderStatus(updated[0]), 'cancelled')
  assert.equal(updated[0].stockRestored, true)
})
