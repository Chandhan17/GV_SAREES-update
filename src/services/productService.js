import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  orderBy,
  query,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import { normalizeImageUrl, normalizeImages } from '../utils/imageHelpers'

function normalizeInventory(data) {
  const totalStock = Math.max(0, Number.isInteger(data.totalStock) ? data.totalStock : 0)
  const reservedStock = Math.min(totalStock, Math.max(0, Number.isInteger(data.reservedStock) ? data.reservedStock : 0))
  const availableStock = Math.max(0, totalStock - reservedStock)
  return {
    totalStock,
    reservedStock,
    availableStock,
    inStock: availableStock > 0,
    lowStockThreshold: Math.max(0, Number.isInteger(data.lowStockThreshold) ? data.lowStockThreshold : 2),
  }
}

const productsCollection = collection(db, 'products')
let productsCache = null
let productsPromise = null

function normalizeProduct(snapshot) {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    ...data,
    images: normalizeImages(data.images || []),
    sizeChartImage: normalizeImageUrl(data.sizeChartImage),
    ...normalizeInventory(data),
  }
}

export function invalidateProductsCache() {
  productsCache = null
  productsPromise = null
}

export async function fetchProducts(forceRefresh = false) {
  if (!forceRefresh && productsCache) {
    return productsCache
  }

  if (!forceRefresh && productsPromise) {
    return productsPromise
  }

  const productsQuery = query(productsCollection, orderBy('createdAt', 'desc'))

  const readProducts = forceRefresh ? getDocsFromServer : getDocs
  productsPromise = readProducts(productsQuery)
    .then((snapshot) => {
      productsCache = snapshot.docs.map(normalizeProduct)
      return productsCache
    })
    .finally(() => {
      productsPromise = null
    })

  return productsPromise
}

export async function fetchProductById(productId) {
  if (productsCache) {
    const found = productsCache.find((product) => product.id === productId)
    if (found) return found
  }

  const productRef = doc(db, 'products', productId)
  const snapshot = await getDoc(productRef)

  if (!snapshot.exists()) {
    return null
  }

  return normalizeProduct(snapshot)
}

export async function createProduct(payload, idempotencyKey) {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Authentication required.')
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new Error('A valid idempotency key is required.')
  }
  const images = normalizeImages(payload.images || [])
  if (!images.length) throw new Error('At least one product image is required.')

  const data = {
    action: 'create',
    name: payload.name,
    price: payload.price,
    category: payload.category,
    description: payload.description,
    fabric: payload.fabric,
    images,
    sizeLength: payload.sizeLength || '',
    sizeChartText: payload.sizeChartText || '',
    ...(Object.prototype.hasOwnProperty.call(payload, 'sizeChartImage')
      ? { sizeChartImage: normalizeImageUrl(payload.sizeChartImage) }
      : {}),
    totalStock: Math.max(0, Number.isInteger(payload.totalStock) ? payload.totalStock : 0),
    lowStockThreshold: Math.max(0, Number.isInteger(payload.lowStockThreshold) ? payload.lowStockThreshold : 2),
  }

  const response = await fetch('/api/admin/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to create product.')
  if (!body.productId) throw new Error('Product creation returned no product ID.')

  invalidateProductsCache()
  return body.productId
}

export async function editProduct(productId, payload) {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Authentication required.')

  const data = {
    action: 'update',
    productId,
  }
  for (const field of ['name', 'price', 'category', 'description', 'fabric', 'sizeLength', 'sizeChartText']) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      data[field] = payload[field]
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'images')) {
    data.images = normalizeImages(payload.images || [])
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'sizeChartImage')) {
    data.sizeChartImage = normalizeImageUrl(payload.sizeChartImage)
  }

  const response = await fetch('/api/admin/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to update product.')
  if (!body.productId) throw new Error('Product update returned no product ID.')

  invalidateProductsCache()
  return body.productId
}

export async function removeProduct(productId) {
  const token = await auth.currentUser?.getIdToken()
  const response = await fetch('/api/admin/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: 'delete', productId }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to delete product.')
  invalidateProductsCache()
  return { success: true, productId }
}
