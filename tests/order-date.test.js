import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatStoreDate,
  formatStoreDateTime,
  getOrderDate,
  getStoreDateKey,
  isOrderWithinDateRange,
  validateOrderDateRange,
} from '../src/utils/orderDate.js'

function firestoreTimestamp(value) {
  const date = new Date(value)
  return {
    toDate: () => date,
    toMillis: () => date.getTime(),
  }
}

test('date filters include the full start and end dates in Asia/Kolkata', () => {
  const startOfFirstDay = firestoreTimestamp('2026-02-28T18:30:00.000Z')
  const endOfLastDay = firestoreTimestamp('2026-03-02T18:29:59.999Z')

  assert.equal(isOrderWithinDateRange(startOfFirstDay, '2026-03-01', '2026-03-02'), true)
  assert.equal(isOrderWithinDateRange(endOfLastDay, '2026-03-01', '2026-03-02'), true)
  assert.equal(isOrderWithinDateRange(new Date('2026-02-28T18:29:59.999Z'), '2026-03-01', '2026-03-02'), false)
  assert.equal(isOrderWithinDateRange(new Date('2026-03-02T18:30:00.000Z'), '2026-03-01', '2026-03-02'), false)
})

test('Firestore timestamps, date strings, and legacy serialized timestamp objects normalize consistently', () => {
  const date = new Date('2026-11-24T20:00:00.000Z')
  assert.equal(getOrderDate(firestoreTimestamp(date.toISOString())).getTime(), date.getTime())
  assert.equal(getOrderDate(date.toISOString()).getTime(), date.getTime())
  assert.equal(getOrderDate({ seconds: date.getTime() / 1000, nanoseconds: 0 }).getTime(), date.getTime())
  assert.equal(formatStoreDate(date), '25/11/2026')
  assert.equal(formatStoreDateTime(date), '25/11/2026, 01:30 IST')
  assert.equal(getStoreDateKey(date), '2026-11-25')
})

test('date range validation rejects invalid dates and a start after the end', () => {
  assert.match(validateOrderDateRange('2026-02-30', ''), /valid start date/)
  assert.match(validateOrderDateRange('2026-03-02', '2026-03-01'), /later than end date/)
  assert.equal(validateOrderDateRange('', ''), '')
})
