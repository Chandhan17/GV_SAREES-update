import { STORE_WHATSAPP_NUMBER } from '../config/storeContact.js'

function isVerifiedPaidOrder(order) {
  const hasIdentifier = (value) => typeof value === 'string' && value.trim().length > 0

  return order?.paymentStatus === 'captured'
    && order?.orderStatus === 'confirmed'
    && hasIdentifier(order?.orderId)
    && hasIdentifier(order?.paymentId)
}

function getProducts(order) {
  if (Array.isArray(order?.products) && order.products.length) {
    return order.products
  }

  return [{
    productId: order?.productId,
    productName: order?.productName,
    quantity: order?.quantity,
    unitPrice: order?.unitPrice,
  }]
}

function getProductUrl(productId, origin) {
  if (productId === undefined || productId === null || !String(productId).trim()) return ''

  const currentOrigin = origin || (typeof window !== 'undefined' ? window.location.origin : '')
  if (!currentOrigin) return ''

  try {
    return new URL(`/products/${encodeURIComponent(String(productId))}`, currentOrigin).toString()
  } catch {
    return ''
  }
}

function getAddressValue(customer, keys) {
  const addressObject = customer?.address && typeof customer.address === 'object'
    ? customer.address
    : {}
  const sources = [customer?.addressFields, addressObject, customer]

  for (const source of sources) {
    for (const key of keys) {
      const value = String(source?.[key] ?? '').trim()
      if (value) return value
    }
  }
  return ''
}

export function createOrderWhatsAppMessage(order, origin) {
  if (!isVerifiedPaidOrder(order)) return ''

  const products = getProducts(order)
  const productUrls = products
    .map((product) => getProductUrl(product?.productId || product?.id, origin))
    .filter(Boolean)
  const productLines = products.map((product) => {
    const selectedSize = product.selectedSize || product.sizeLength
    const size = selectedSize ? ` · Size ${selectedSize}` : ''
    return `${product.productName || product.name || 'Product'}${size} — Qty ${product.quantity ?? 0} × ₹${product.unitPrice ?? product.price ?? 0}`
  })
  const customer = order.customer || {}
  const addressLines = [
    ['Door No', ['doorNo', 'doorNumber']],
    ['Street', ['streetName', 'street']],
    ['City', ['city']],
    ['Pincode', ['pincode', 'pinCode', 'postalCode']],
    ['State', ['state']],
  ]
    .map(([label, keys]) => {
      const value = getAddressValue(customer, keys)
      return value ? `${label}: ${value}` : ''
    })
    .filter(Boolean)

  return [
    ...productUrls,
    ...(productUrls.length ? [''] : []),
    'GV Sarees order confirmation',
    `Order ID: ${order.orderId}`,
    '',
    'Products:',
    ...productLines,
    `Total amount: ₹${order.totalAmount ?? 0}`,
    '',
    '💳 Payment Status: Paid',
    '',
    'Customer Details:',
    ...(customer.name ? [`👤 Name: ${customer.name}`] : []),
    ...(customer.phone ? [`📞 Phone: ${customer.phone}`] : []),
    ...(addressLines.length ? ['', '📍 Address:', ...addressLines] : []),
  ].join('\n')
}

export function createOrderWhatsAppUrl(phoneNumber, message) {
  const internationalNumber = typeof phoneNumber === 'string' ? phoneNumber.trim() : ''
  if (!/^\+[1-9]\d{7,14}$/.test(internationalNumber)) return ''
  try {
    return `https://wa.me/${internationalNumber.slice(1)}?text=${encodeURIComponent(message)}`
  } catch {
    return ''
  }
}

export function createVerifiedOrderWhatsAppUrl(phoneNumber, order, origin) {
  if (!isVerifiedPaidOrder(order)) return ''
  return createOrderWhatsAppUrl(phoneNumber, createOrderWhatsAppMessage(order, origin))
}

export function createVerifiedOrdersWhatsAppUrl(phoneNumber, orders, origin) {
  if (!Array.isArray(orders) || !orders.length || !orders.every(isVerifiedPaidOrder)) return ''
  const message = orders
    .map((order) => createOrderWhatsAppMessage(order, origin))
    .join('\n\n')
  return createOrderWhatsAppUrl(phoneNumber, message)
}

function navigateInSameTab(url) {
  if (typeof window === 'undefined') return false
  window.location.assign(url)
  return true
}

export function completeOrderWhatsAppHandoff(phoneNumber, order, origin, navigate = navigateInSameTab) {
  const url = createVerifiedOrderWhatsAppUrl(phoneNumber, order, origin)
  if (!url) return { url: '', opened: false }
  try {
    return { url, opened: navigate(url) !== false }
  } catch {
    return { url, opened: false }
  }
}

export async function completeOrderWhatsAppHandoffs(
  orders,
  getStoreSettings,
  navigate = navigateInSameTab,
  origin,
) {
  if (!Array.isArray(orders) || !orders.length) return []
  if (!orders.every(isVerifiedPaidOrder)) {
    return orders.map((order) => ({
      orderId: order?.orderId,
      status: 'unavailable',
      reason: 'unverified-order',
    }))
  }

  const createResults = (status, reason, url) => orders.map((order) => ({
    orderId: order.orderId,
    status,
    ...(reason ? { reason } : {}),
    ...(url ? { url } : {}),
  }))

  let settings
  try {
    settings = await getStoreSettings()
  } catch {
    const retryUrl = createVerifiedOrdersWhatsAppUrl(STORE_WHATSAPP_NUMBER, orders, origin)
    return retryUrl
      ? createResults('fallback', 'settings-load-failed', retryUrl)
      : createResults('unavailable', 'url-generation-failed')
  }

  const url = createVerifiedOrdersWhatsAppUrl(settings?.whatsappNumber, orders, origin)
  if (!url) {
    const retryUrl = createVerifiedOrdersWhatsAppUrl(STORE_WHATSAPP_NUMBER, orders, origin)
    const reason = typeof settings?.whatsappNumber === 'string'
      && settings.whatsappNumber.trim()
      ? 'invalid-number'
      : 'not-configured'
    return retryUrl
      ? createResults('fallback', reason, retryUrl)
      : createResults('unavailable', 'url-generation-failed')
  }

  try {
    if (navigate(url) === false) return createResults('fallback', 'navigation-failed', url)
  } catch {
    return createResults('fallback', 'navigation-failed', url)
  }
  return createResults('opened', '', url)
}
