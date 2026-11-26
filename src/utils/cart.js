export const CART_STORAGE_KEY = 'gv-sarees-cart-v1'
export const BUY_NOW_STORAGE_KEY = 'gv-sarees-buy-now-v1'

function createRequestKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getProductImage(product) {
  const image = Array.isArray(product.images) ? product.images[0] : product.image
  return typeof image === 'string' ? image : image?.url || ''
}

function normalizeCartItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
    return null
  }
  const price = Number(item.price)
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    price: Number.isFinite(price) && price >= 0 ? price : 0,
    image: typeof item.image === 'string' ? item.image : '',
    sizeLength: typeof item.sizeLength === 'string' ? item.sizeLength : '',
    availableStock: Number.isSafeInteger(item.availableStock) && item.availableStock >= 0 ? item.availableStock : 0,
    quantity: item.quantity,
    reservationKey: typeof item.reservationKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(item.reservationKey)
      ? item.reservationKey
      : createRequestKey(),
  }
}

export function readCartItems(storage) {
  const raw = storage.getItem(CART_STORAGE_KEY)
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items = parsed.map(normalizeCartItem).filter(Boolean)
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

export function writeCartItems(items, storage) {
  storage.setItem(CART_STORAGE_KEY, JSON.stringify(items.map(normalizeCartItem).filter(Boolean)))
}

export function readBuyNowItem(storage) {
  const raw = storage.getItem(BUY_NOW_STORAGE_KEY)
  if (!raw) return null
  try {
    return normalizeCartItem(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeBuyNowItem(item, storage) {
  if (!item) {
    storage.removeItem(BUY_NOW_STORAGE_KEY)
    return
  }
  const normalized = normalizeCartItem(item)
  if (!normalized) throw new Error('This product cannot be checked out.')
  storage.setItem(BUY_NOW_STORAGE_KEY, JSON.stringify(normalized))
}

function snapshotProduct(product, quantity, reservationKey = createRequestKey()) {
  return {
    id: product.id,
    name: typeof product.name === 'string' ? product.name : '',
    price: Number.isFinite(Number(product.price)) && Number(product.price) >= 0 ? Number(product.price) : 0,
    image: getProductImage(product),
    sizeLength: typeof product.sizeLength === 'string' ? product.sizeLength : '',
    availableStock: Number.isSafeInteger(product.availableStock) && product.availableStock >= 0 ? product.availableStock : 0,
    quantity,
    reservationKey,
  }
}

export function createBuyNowCartItem(product, quantity = 1) {
  if (!product || typeof product.id !== 'string' || !product.id.trim()) {
    throw new Error('This product cannot be checked out.')
  }
  const availableStock = Number.isSafeInteger(product.availableStock) ? product.availableStock : 0
  if (availableStock < 1) throw new Error('This product is currently out of stock.')
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error('Checkout quantity must be a positive whole number.')
  }
  if (quantity > availableStock) {
    throw new Error(`Only ${availableStock} item(s) are currently available.`)
  }
  return snapshotProduct(product, quantity)
}

export function addCartProduct(items, product, quantityToAdd = 1) {
  if (!product || typeof product.id !== 'string' || !product.id.trim()) {
    throw new Error('This product cannot be added to the cart.')
  }
  if (!Number.isSafeInteger(quantityToAdd) || quantityToAdd < 1) {
    throw new Error('Cart quantity must be a positive whole number.')
  }
  const availableStock = Number.isSafeInteger(product.availableStock) ? product.availableStock : 0
  if (availableStock < 1) throw new Error('This product is currently out of stock.')

  const existing = items.find((item) => item.id === product.id)
  const quantity = (existing?.quantity || 0) + quantityToAdd
  if (quantity > availableStock) {
    throw new Error(`Only ${availableStock} item(s) are currently available.`)
  }
  const updated = snapshotProduct(product, quantity, existing?.reservationKey || createRequestKey())
  return existing
    ? items.map((item) => item.id === product.id ? updated : item)
    : [...items, updated]
}

export function setCartProductQuantity(items, productId, quantity, availableStock) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error('Cart quantity must be a positive whole number.')
  }
  const existing = items.find((item) => item.id === productId)
  if (!existing) return items
  const stockLimit = Number.isSafeInteger(availableStock) ? availableStock : existing.availableStock
  if (quantity > stockLimit && quantity > existing.quantity) {
    throw new Error(`Only ${stockLimit} item(s) are currently available.`)
  }
  return items.map((item) => item.id === productId
    ? { ...item, quantity, availableStock: stockLimit }
    : item)
}

export function removeCartProduct(items, productId) {
  return items.filter((item) => item.id !== productId)
}

export function clearCartItems() {
  return []
}

export function getCartItemCount(items) {
  return items.reduce((total, item) => total + item.quantity, 0)
}

export function getCartSubtotal(items, productById = new Map()) {
  return items.reduce((total, item) => {
    const product = productById.get(item.id)
    const price = product ? Number(product.price) : Number(item.price)
    return total + item.quantity * (Number.isFinite(price) && price >= 0 ? price : 0)
  }, 0)
}

export function getCartAvailabilityErrors(items, products) {
  const productById = products instanceof Map
    ? products
    : new Map(products.map((product) => [product.id, product]))
  return items.flatMap((item) => {
    const product = productById.get(item.id)
    if (!product) return [{ productId: item.id, message: `${item.name || 'This product'} is no longer available.` }]
    const availableStock = Number.isSafeInteger(product.availableStock) ? product.availableStock : 0
    if (availableStock < item.quantity) {
      return [{
        productId: item.id,
        message: availableStock
          ? `Only ${availableStock} item(s) of ${product.name || item.name} are currently available.`
          : `${product.name || item.name} is currently out of stock.`,
      }]
    }
    return []
  })
}
