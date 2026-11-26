const STORE_TIME_ZONE = 'Asia/Kolkata'
const INDIA_OFFSET_MINUTES = 330

export function getOrderDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate()
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null
  }
  if (value && typeof value.toMillis === 'function') {
    const date = new Date(value.toMillis())
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (value && typeof value === 'object') {
    const seconds = value.seconds ?? value._seconds
    const nanoseconds = value.nanoseconds ?? value._nanoseconds ?? 0
    if (Number.isFinite(seconds)) {
      const date = new Date((seconds * 1000) + Math.floor(nanoseconds / 1e6))
      return Number.isNaN(date.getTime()) ? null : date
    }
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseDateInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null
  return { year, month, day }
}

function getStoreDayBoundary(value, isEnd) {
  const parts = parseDateInput(value)
  if (!parts) return null
  const nextDay = Date.UTC(parts.year, parts.month - 1, parts.day + (isEnd ? 1 : 0))
  const start = nextDay - (INDIA_OFFSET_MINUTES * 60 * 1000)
  return isEnd ? start - 1 : start
}

export function validateOrderDateRange(startDate, endDate) {
  if (startDate && !parseDateInput(startDate)) return 'Enter a valid start date.'
  if (endDate && !parseDateInput(endDate)) return 'Enter a valid end date.'
  if (startDate && endDate && startDate > endDate) return 'Start date must not be later than end date.'
  return ''
}

export function isOrderWithinDateRange(orderDate, startDate, endDate) {
  if (!startDate && !endDate) return true
  const timestamp = getOrderDate(orderDate)?.getTime()
  if (!Number.isFinite(timestamp)) return false
  const start = startDate ? getStoreDayBoundary(startDate, false) : null
  const end = endDate ? getStoreDayBoundary(endDate, true) : null
  return (start === null || timestamp >= start) && (end === null || timestamp <= end)
}

export function getStoreDateParts(value) {
  const date = getOrderDate(value)
  if (!date) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

export function formatStoreDate(value) {
  const parts = getStoreDateParts(value)
  if (!parts) return '--'
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`
}

export function formatStoreDateTime(value) {
  const parts = getStoreDateParts(value)
  if (!parts) return '--'
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}, ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} IST`
}

export function getExcelStoreDate(value) {
  const parts = getStoreDateParts(value)
  if (!parts) return null
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
}

export function getExcelStoreTime(value) {
  const parts = getStoreDateParts(value)
  if (!parts) return null
  return ((parts.hour * 3600) + (parts.minute * 60) + parts.second) / 86400
}

export function getStoreDateKey(value) {
  const parts = getStoreDateParts(value)
  if (!parts) return ''
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}
