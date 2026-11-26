export const CUSTOMER_DETAILS_STORAGE_KEY = 'saree_store_customer_details'

export const DEFAULT_CUSTOMER_DETAILS = {
  name: '',
  phone: '',
  doorNo: '',
  streetName: '',
  city: '',
  pincode: '',
  state: '',
}

export function normalizeCustomerDetails(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CUSTOMER_DETAILS }
  const streetName = value.streetName || value.address || ''
  return {
    name: String(value.name ?? ''),
    phone: String(value.phone ?? ''),
    doorNo: String(value.doorNo ?? ''),
    streetName: String(streetName ?? ''),
    city: String(value.city ?? ''),
    pincode: String(value.pincode ?? ''),
    state: String(value.state ?? ''),
  }
}

export function normalizeIndianMobileNumber(value) {
  const input = String(value ?? '').trim()
  if (!input || !/^\+?[\d\s-]+$/.test(input)) return null

  let digits = input.replace(/\D/g, '')
  if (input.startsWith('+') && !digits.startsWith('91')) return null
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  if (!/^[6-9]\d{9}$/.test(digits)) return null
  return digits
}

export function buildCustomerAddress(customer) {
  return [customer.doorNo, customer.streetName, customer.city, customer.pincode, customer.state]
    .map((value) => String(value || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ')
}

export function validateCustomerDetails(customer) {
  const errors = {}
  if (!String(customer.name || '').trim()) errors.name = 'Enter your full name.'
  if (!normalizeIndianMobileNumber(customer.phone)) {
    errors.phone = 'Enter a valid 10-digit Indian mobile number, with optional +91.'
  }
  if (!String(customer.doorNo || '').trim()) errors.doorNo = 'Enter your house or door number.'
  if (!String(customer.streetName || '').trim()) errors.streetName = 'Enter your address or locality.'
  if (!String(customer.city || '').trim()) errors.city = 'Enter your city.'
  if (!/^\d{6}$/.test(String(customer.pincode || '').trim())) errors.pincode = 'Enter a valid 6-digit PIN code.'
  if (!String(customer.state || '').trim()) errors.state = 'Enter your state.'
  return errors
}

export function normalizeCustomerSubmission(customer) {
  const normalized = normalizeCustomerDetails(customer)
  return {
    name: normalized.name.trim().replace(/\s+/g, ' '),
    phone: normalizeIndianMobileNumber(normalized.phone) || '',
    doorNo: normalized.doorNo.trim().replace(/\s+/g, ' '),
    streetName: normalized.streetName.trim().replace(/\s+/g, ' '),
    city: normalized.city.trim().replace(/\s+/g, ' '),
    pincode: normalized.pincode.trim(),
    state: normalized.state.trim().replace(/\s+/g, ' '),
  }
}

export function reservationQuantityError(value, availableStock) {
  const input = String(value ?? '').trim()
  if (!/^\d+$/.test(input)) return 'Enter a whole-number quantity greater than zero.'

  const quantity = Number(input)
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return 'Enter a whole-number quantity greater than zero.'
  }
  if (!Number.isInteger(availableStock) || availableStock < 1) return 'This product is currently out of stock.'
  if (quantity > availableStock) return `Only ${availableStock} item(s) are currently available.`
  return ''
}

export function parseReservationQuantity(value, availableStock) {
  return reservationQuantityError(value, availableStock) ? null : Number(value)
}
