import { strToU8, zipSync } from 'fflate'
import {
  getExcelStoreDate,
  getExcelStoreTime,
  getStoreDateKey,
  getOrderDate,
} from './orderDate.js'

const ORDER_COLUMNS = [
  ['orderId', 'Order ID', 30],
  ['orderDate', 'Order Date', 16],
  ['orderTime', 'Order Time', 14],
  ['customerName', 'Customer Name', 24],
  ['customerEmail', 'Customer Email', 28],
  ['customerPhone', 'Customer Phone', 18],
  ['deliveryAddress', 'Delivery Address', 40],
  ['city', 'City', 20],
  ['state', 'State', 20],
  ['pinCode', 'PIN Code', 14],
  ['productName', 'Product Name(s)', 34],
  ['productId', 'Product ID(s)', 30],
  ['quantity', 'Quantity', 12],
  ['unitPrice', 'Unit Price', 16],
  ['subtotal', 'Subtotal', 16],
  ['shippingCharge', 'Shipping Charge', 18],
  ['discount', 'Discount', 16],
  ['totalAmount', 'Total Amount', 18],
  ['paymentMethod', 'Payment Method', 18],
  ['paymentStatus', 'Payment Status', 18],
  ['razorpayPaymentId', 'Razorpay Payment ID', 28],
  ['razorpayOrderIds', 'Razorpay Order IDs', 34],
  ['razorpayRefundId', 'Razorpay Refund ID', 28],
  ['orderStatus', 'Order Status', 18],
  ['fulfillmentStatus', 'Fulfillment Status', 22],
  ['trackingNumber', 'Tracking Number', 22],
  ['refundStatus', 'Refund Status', 18],
]

const ITEM_COLUMNS = [
  ['orderId', 'Order ID', 30],
  ['productId', 'Product ID', 30],
  ['productName', 'Product Name', 34],
  ['quantity', 'Quantity', 12],
  ['unitPrice', 'Unit Price', 16],
  ['lineSubtotal', 'Line Subtotal', 18],
]

const SUMMARY_COLUMNS = [['metric', 'Metric', 38], ['value', 'Value', 36]]
const CURRENCY_FORMAT = '"₹"#,##0.00;[Red]-"₹"#,##0.00'

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function amountFromFields(order, valueFields, paiseFields = []) {
  for (const field of valueFields) {
    const value = numberOrNull(order[field])
    if (value !== null) return value
  }
  for (const field of paiseFields) {
    const value = numberOrNull(order[field])
    if (value !== null) return value / 100
  }
  return null
}

function getOrderItems(order) {
  const storedItems = [order.orderItems, order.items, order.products]
    .find((value) => Array.isArray(value) && value.length)
  if (storedItems) {
    const items = storedItems.filter((item) => item && typeof item === 'object').map((item) => {
      const quantity = numberOrNull(item.quantity ?? item.reservedQuantity) || 0
      const subtotal = numberOrNull(item.lineSubtotal ?? item.subtotal ?? item.lineTotal)
      const listedUnitPrice = numberOrNull(item.unitPrice ?? item.price)
      const unitPrice = listedUnitPrice ?? (quantity > 0 && subtotal !== null ? subtotal / quantity : 0)
      return {
        productId: item.productId || item.id || '',
        productName: item.productName || item.name || '',
        quantity,
        unitPrice,
        lineSubtotal: subtotal ?? quantity * unitPrice,
      }
    })
    if (items.length) return items
  }

  const quantity = numberOrNull(order.reservedQuantity ?? order.quantity) || 0
  const unitPrice = numberOrNull(order.price ?? order.unitPrice) || 0
  return [{
    productId: order.productId || '',
    productName: order.productName || '',
    quantity,
    unitPrice,
    lineSubtotal: quantity * unitPrice,
  }]
}

function getAddressParts(customerValue) {
  const customer = customerValue && typeof customerValue === 'object' ? customerValue : {}
  const address = customer.address
  const addressFields = address && typeof address === 'object' ? address : {}
  const deliveryAddress = typeof address === 'string'
    ? address
    : [
      customer.doorNo || addressFields.doorNo,
      customer.streetName || addressFields.streetName,
      customer.area || addressFields.area,
      customer.city || addressFields.city,
      customer.state || addressFields.state,
      customer.pincode || customer.pinCode || addressFields.pincode || addressFields.pinCode,
    ].filter(Boolean).join(', ')
  return {
    deliveryAddress,
    city: customer.city || addressFields.city || '',
    state: customer.state || addressFields.state || '',
    pinCode: customer.pincode || customer.pinCode || addressFields.pincode || addressFields.pinCode || '',
  }
}

function getOrderTotal(order, subtotal) {
  const explicitTotal = amountFromFields(order, ['totalAmount', 'total'], ['totalAmountPaise'])
  if (explicitTotal !== null) return explicitTotal
  const paymentAmount = amountFromFields(order, [], ['paymentAmountPaise'])
  if (paymentAmount !== null) return paymentAmount
  const shipping = amountFromFields(order, ['shippingCharge', 'shippingAmount'], ['shippingChargePaise']) || 0
  const discount = amountFromFields(order, ['discount', 'discountAmount'], ['discountPaise']) || 0
  return subtotal + shipping - discount
}

function getPaidAmount(order, totalAmount) {
  if (!['captured', 'paid', 'refunded'].includes(order.paymentStatus)) return 0
  let paidAmount = order.paymentStatus === 'refunded'
    ? 0
    : amountFromFields(order, [], ['paymentAmountPaise']) ?? totalAmount
  if (order.refundStatus === 'processed') {
    paidAmount -= amountFromFields(order, [], ['refundAmountPaise']) ?? paidAmount
  }
  return Math.max(0, paidAmount)
}

function getOrderRow(order) {
  const items = getOrderItems(order)
  const paymentAttempts = order.paymentAttempts && typeof order.paymentAttempts === 'object'
    ? Object.values(order.paymentAttempts).filter((attempt) => attempt && typeof attempt === 'object')
    : []
  const paymentIds = [...new Set([
    order.razorpayPaymentId,
    ...paymentAttempts.flatMap((attempt) => [
      attempt.paymentId,
      ...Object.keys(attempt.payments || {}),
    ]),
  ].filter((value) => typeof value === 'string' && value))]
  const razorpayOrderIds = [...new Set([
    order.razorpayOrderId,
    ...(Array.isArray(order.razorpayOrderIds) ? order.razorpayOrderIds : []),
    ...paymentAttempts.map((attempt) => attempt.razorpayOrderId),
  ].filter((value) => typeof value === 'string' && value))]
  const address = getAddressParts(order.customer)
  const subtotal = amountFromFields(order, ['subtotal'], ['subtotalPaise'])
    ?? items.reduce((sum, item) => sum + item.lineSubtotal, 0)
  const shippingCharge = amountFromFields(order, ['shippingCharge', 'shippingAmount'], ['shippingChargePaise']) ?? 0
  const discount = amountFromFields(order, ['discount', 'discountAmount'], ['discountPaise']) ?? 0
  const createdAt = getOrderDate(order.createdAt)
  const totalAmount = getOrderTotal(order, subtotal)
  return {
    row: {
      orderId: order.id || order.orderId || '',
      orderDate: getExcelStoreDate(createdAt),
      orderTime: getExcelStoreTime(createdAt),
      customerName: order.customer?.name || '',
      customerEmail: order.customer?.email || order.customerEmail || '',
      customerPhone: order.customer?.phone || '',
      ...address,
      productName: items.map((item) => `${item.productName || 'Product'} (×${item.quantity})`).join('; '),
      productId: items.map((item) => item.productId).filter(Boolean).join('; '),
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: items.length === 1 ? items[0].unitPrice : null,
      subtotal,
      shippingCharge,
      discount,
      totalAmount,
      paymentMethod: order.paymentMethod || '',
      paymentStatus: order.paymentStatus || '',
      razorpayPaymentId: paymentIds.join('; '),
      razorpayOrderIds: razorpayOrderIds.join('; '),
      razorpayRefundId: order.refundId || '',
      orderStatus: order.orderStatus || '',
      fulfillmentStatus: order.fulfillmentStatus || order.shippingStatus || order.orderStatus || '',
      trackingNumber: order.trackingNumber || '',
      refundStatus: order.refundStatus || '',
    },
    items: items.map((item) => ({
      orderId: order.id || order.orderId || '',
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineSubtotal: item.lineSubtotal,
    })),
    totalAmount,
    paidAmount: getPaidAmount(order, totalAmount),
  }
}

export function calculateOrderExportSummary(orders) {
  const rows = orders.map(getOrderRow)
  return {
    totalOrders: rows.length,
    totalOrderValue: rows.reduce((sum, row) => sum + row.totalAmount, 0),
    totalPaidAmount: rows.reduce((sum, row) => sum + row.paidAmount, 0),
    pendingPaymentCount: orders.filter((order) => ['pending', 'authorized'].includes(order.paymentStatus)).length,
    failedPaymentCount: orders.filter((order) => order.paymentStatus === 'failed').length,
    refundedOrderCount: orders.filter((order) =>
      order.paymentStatus === 'refunded' || order.refundStatus === 'processed',
    ).length,
    cancelledOrderCount: orders.filter((order) => order.orderStatus === 'cancelled').length,
  }
}

export function createOrdersFilename(startDate, endDate, now = new Date()) {
  const today = getStoreDateKey(now) || new Date().toISOString().slice(0, 10)
  const range = startDate || endDate ? `${startDate || 'all'}_to_${endDate || 'all'}` : `${today}_to_${today}`
  return `GV_Sarees_Orders_${range}.xlsx`
}

function escapeXml(value) {
  const xmlSafeText = Array.from(String(value))
    .filter((character) => {
      const codePoint = character.codePointAt(0)
      return !(
        codePoint <= 0x08
        || codePoint === 0x0B
        || codePoint === 0x0C
        || (codePoint >= 0x0E && codePoint <= 0x1F)
        || codePoint === 0xFFFE
        || codePoint === 0xFFFF
      )
    })
    .join('')
  return xmlSafeText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function columnName(index) {
  let column = ''
  let number = index
  while (number > 0) {
    const remainder = (number - 1) % 26
    column = String.fromCharCode(65 + remainder) + column
    number = Math.floor((number - 1) / 26)
  }
  return column
}

function excelSerial(date) {
  return (date.getTime() / 86400000) + 25569
}

function serializeCell(reference, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : ''
  if (value === null || value === undefined || value === '') return `<c r="${reference}"${styleAttribute}/>`
  if (value instanceof Date) return `<c r="${reference}"${styleAttribute}><v>${excelSerial(value)}</v></c>`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${styleAttribute}><v>${Object.is(value, -0) ? 0 : value}</v></c>`
  }
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

function serializeRow(row, rowNumber, columns, { header = false, styles = {} } = {}) {
  const height = header ? ' ht="30" customHeight="1"' : ''
  const cells = columns.map(([key], index) => {
    const style = header ? 1 : (row.cellStyles?.[key] ?? styles[key] ?? 0)
    return serializeCell(`${columnName(index + 1)}${rowNumber}`, header ? columns[index][1] : row[key], style)
  }).join('')
  return `<row r="${rowNumber}"${height}>${cells}</row>`
}

function worksheetXml(columns, rows, {
  styles = {},
  autoFilter = false,
  freezeHeader = true,
} = {}) {
  const lastColumn = columnName(columns.length)
  const lastRow = rows.length + 1
  const widths = columns.map(([, , width], index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join('')
  const header = serializeRow({}, 1, columns, { header: true })
  const dataRows = rows.map((row, index) => serializeRow(row, index + 2, columns, { styles })).join('')
  const views = freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    : ''
  const filter = autoFilter ? `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastColumn}${lastRow}"/>
${views}<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${header}${dataRows}</sheetData>${filter}</worksheet>`
}

function workbookStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="dd mmm yyyy"/>
<numFmt numFmtId="165" formatCode="hh:mm AM/PM"/>
<numFmt numFmtId="166" formatCode="&quot;₹&quot;#,##0.00;[Red]-&quot;₹&quot;#,##0.00"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF713C4A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
}

function buildSummaryRows(orders, { startDate, endDate, now }) {
  const summary = calculateOrderExportSummary(orders)
  return [
    { metric: 'Export date (Asia/Kolkata)', value: getStoreDateKey(now) },
    { metric: 'Applied date range (Asia/Kolkata)', value: startDate || endDate ? `${startDate || 'Any'} to ${endDate || 'Any'}` : 'All dates' },
    { metric: 'Total number of orders', value: summary.totalOrders },
    { metric: 'Total order value (INR)', value: summary.totalOrderValue, cellStyles: { value: 4 } },
    { metric: 'Total paid amount (INR, net of processed refunds)', value: summary.totalPaidAmount, cellStyles: { value: 4 } },
    { metric: 'Pending payment count', value: summary.pendingPaymentCount },
    { metric: 'Failed payment count', value: summary.failedPaymentCount },
    { metric: 'Refunded order count', value: summary.refundedOrderCount },
    { metric: 'Cancelled order count', value: summary.cancelledOrderCount },
  ]
}

export async function createOrdersWorkbook(orders, {
  startDate = '',
  endDate = '',
  now = new Date(),
} = {}) {
  const orderRows = orders.map(getOrderRow)
  const flattenedItems = orderRows.flatMap((order) => order.items)
  const summaryRows = buildSummaryRows(orders, { startDate, endDate, now })

  const orderStyles = {
    orderDate: 2,
    orderTime: 3,
    unitPrice: 4,
    subtotal: 4,
    shippingCharge: 4,
    discount: 4,
    totalAmount: 4,
  }
  const itemStyles = { unitPrice: 4, lineSubtotal: 4 }

  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="Orders" sheetId="1" r:id="rId1"/><sheet name="Order Items" sheetId="2" r:id="rId2"/><sheet name="Summary" sheetId="3" r:id="rId3"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(workbookStylesXml()),
    'xl/worksheets/sheet1.xml': strToU8(worksheetXml(
      ORDER_COLUMNS,
      orderRows.map((order) => order.row),
      { styles: orderStyles, autoFilter: true },
    )),
    'xl/worksheets/sheet2.xml': strToU8(worksheetXml(
      ITEM_COLUMNS,
      flattenedItems,
      { styles: itemStyles, autoFilter: true },
    )),
    'xl/worksheets/sheet3.xml': strToU8(worksheetXml(
      SUMMARY_COLUMNS,
      summaryRows,
    )),
  }

  return zipSync(files, { level: 6 })
}
