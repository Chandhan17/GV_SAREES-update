const CACHE_TTL_MS = 5 * 60 * 1000
let cachedProductIds = null
let cacheExpiresAt = 0
let requestInFlight = null

export async function fetchBestSellerProductIds({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedProductIds && cacheExpiresAt > Date.now()) {
    return [...cachedProductIds]
  }
  if (!forceRefresh && requestInFlight) return [...await requestInFlight]

  requestInFlight = (async () => {
    const response = await fetch('/api/best-sellers', { headers: { Accept: 'application/json' } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.message || 'Unable to load best sellers.')
    if (!Array.isArray(body.productIds)) {
      throw new Error('Best sellers response is invalid.')
    }
    return [...new Set(body.productIds.filter((productId) => (
      typeof productId === 'string' && productId.length > 0
    )))]
  })()

  try {
    const productIds = await requestInFlight
    cachedProductIds = productIds
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
    return [...productIds]
  } finally {
    requestInFlight = null
  }
}
