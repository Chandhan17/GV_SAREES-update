import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import test from 'node:test'
import {
  calculateOrderExportSummary,
  createOrdersFilename,
  createOrdersWorkbook,
} from '../src/utils/orderExport.js'

function getWorkbookXml(bytes, path) {
  const files = unzipSync(bytes)
  assert.ok(files[path], `${path} should be included in the workbook`)
  return strFromU8(files[path])
}

function getCell(xml, reference) {
  const escapedReference = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = xml.match(new RegExp(`<c r="${escapedReference}"([^>]*)>([\\s\\S]*?)</c>`))
  assert.ok(match, `Expected workbook cell ${reference}`)
  if (match[1].includes('t="inlineStr"')) {
    const text = match[2].match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/)?.[1] || ''
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  }
  return Number(match[2].match(/<v>([\s\S]*?)<\/v>/)?.[1])
}

function excelSerial(year, month, day) {
  return (Date.UTC(year, month - 1, day) / 86400000) + 25569
}

test('Excel workbook contains order and item sheets without duplicating multi-product order totals', async () => {
  const orders = [{
    id: 'order-1',
    createdAt: '2026-11-24T20:00:00.000Z',
    customer: {
      name: 'Test Customer',
      email: 'customer@example.com',
      phone: '9876543210',
      address: '12 Main Road, Chennai',
      city: 'Chennai',
      state: 'Tamil Nadu',
      pincode: '600001',
    },
    orderItems: [
      { productId: 'saree-1', productName: 'Silk Saree', quantity: 2, unitPrice: 100 },
      { productId: 'saree-2', productName: 'Cotton Saree', quantity: 1, unitPrice: 100 },
    ],
    subtotal: 300,
    totalAmount: 300,
    paymentAmountPaise: 30000,
    paymentMethod: 'razorpay',
    paymentStatus: 'captured',
    paymentAttempts: {
      attempt1: {
        status: 'captured',
        paymentId: 'pay-nested',
        razorpayOrderId: 'order-nested',
        payments: { 'pay-nested': { status: 'captured' } },
      },
    },
    razorpayPaymentId: 'pay-123',
    razorpayOrderIds: ['order-main'],
    refundId: 'rfnd-123',
    orderStatus: 'delivered',
    refundStatus: 'processed',
    refundAmountPaise: 10000,
  }, {
    id: 'order-failed',
    createdAt: '2026-11-24T10:00:00.000Z',
    productName: 'Failed Payment Saree',
    productId: 'saree-3',
    price: 250,
    reservedQuantity: 1,
    totalAmount: 250,
    paymentStatus: 'failed',
    orderStatus: 'cancelled',
  }]

  const workbook = await createOrdersWorkbook(orders, {
    startDate: '2026-11-25',
    endDate: '2026-11-25',
    now: new Date('2026-11-24T20:00:00.000Z'),
  })
  assert.equal(String.fromCharCode(workbook[0], workbook[1]), 'PK')
  const ordersSheet = getWorkbookXml(workbook, 'xl/worksheets/sheet1.xml')
  const itemsSheet = getWorkbookXml(workbook, 'xl/worksheets/sheet2.xml')
  const summarySheet = getWorkbookXml(workbook, 'xl/worksheets/sheet3.xml')

  assert.equal((ordersSheet.match(/<row r=/g) || []).length, 3)
  assert.equal(getCell(ordersSheet, 'A2'), 'order-1')
  assert.equal(getCell(ordersSheet, 'B2'), excelSerial(2026, 11, 25))
  assert.equal(getCell(ordersSheet, 'M2'), 3)
  assert.match(ordersSheet, /<c r="N2"[^>]*\/>/)
  assert.equal(getCell(ordersSheet, 'R2'), 300)
  assert.equal(getCell(ordersSheet, 'R3'), 250)
  assert.equal(getCell(ordersSheet, 'U2'), 'pay-123; pay-nested')
  assert.equal(getCell(ordersSheet, 'V2'), 'order-main; order-nested')
  assert.equal(getCell(ordersSheet, 'W2'), 'rfnd-123')
  assert.equal((itemsSheet.match(/<row r=/g) || []).length, 4)
  assert.equal(getCell(itemsSheet, 'F2'), 200)
  assert.equal(getCell(itemsSheet, 'F3'), 100)
  assert.match(itemsSheet, /Line Subtotal/)
  assert.match(ordersSheet, /state="frozen"/)
  assert.match(ordersSheet, /<autoFilter ref="A1:AA3"\/>/)
  assert.equal(getCell(summarySheet, 'B4'), 2)
  assert.equal(getCell(summarySheet, 'B5'), 550)
  assert.equal(getCell(summarySheet, 'B6'), 200)
  assert.equal(getCell(summarySheet, 'B7'), 0)
  assert.equal(getCell(summarySheet, 'B8'), 1)
  assert.equal(getCell(summarySheet, 'B9'), 1)
  assert.equal(getCell(summarySheet, 'B10'), 1)
})

test('Excel export includes all supplied matching orders and supports no date filter', async () => {
  const orders = Array.from({ length: 260 }, (_, index) => ({
    id: `order-${index + 1}`,
    createdAt: '2026-11-24T12:00:00.000Z',
    paymentStatus: 'failed',
    orderStatus: 'cancelled',
    price: 10,
    reservedQuantity: 1,
  }))

  const workbook = await createOrdersWorkbook(orders)
  const sheet = getWorkbookXml(workbook, 'xl/worksheets/sheet1.xml')
  assert.equal((sheet.match(/<row r=/g) || []).length, 261)
  assert.equal(getCell(sheet, 'A261'), 'order-260')
  assert.equal(calculateOrderExportSummary(orders).totalOrders, 260)
  const adminOrdersPage = readFileSync(new URL('../src/pages/AdminOrders.jsx', import.meta.url), 'utf8')
  assert.match(adminOrdersPage, /exportOrdersToExcel\(filteredOrders/)
  assert.match(createOrdersFilename('', '', new Date('2026-11-24T20:00:00.000Z')), /2026-11-25_to_2026-11-25\.xlsx$/)
  assert.match(createOrdersFilename('2026-11-01', '2026-11-24'), /2026-11-01_to_2026-11-24\.xlsx$/)
})

test('summary excludes failed and refunded payments from net paid amount', () => {
  const summary = calculateOrderExportSummary([
    { paymentStatus: 'captured', paymentAmountPaise: 50000, refundStatus: 'processed', refundAmountPaise: 50000 },
    { paymentStatus: 'failed', totalAmount: 900 },
    { paymentStatus: 'pending', totalAmount: 1000 },
  ])
  assert.equal(summary.totalOrderValue, 2400)
  assert.equal(summary.totalPaidAmount, 0)
  assert.equal(summary.pendingPaymentCount, 1)
  assert.equal(summary.failedPaymentCount, 1)
  assert.equal(summary.refundedOrderCount, 1)
})
