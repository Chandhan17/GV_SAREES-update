import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import { normalizeImageUrl, normalizeImages } from '../utils/imageHelpers'
import { deleteTelegramMedia } from './telegramMediaService'

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

  productsPromise = getDocs(productsQuery)
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

export async function createProduct(payload) {
  const totalStock = Math.max(0, Number.isInteger(payload.totalStock) ? payload.totalStock : 0)
  const lowStockThreshold = Math.max(0, Number.isInteger(payload.lowStockThreshold) ? payload.lowStockThreshold : 2)
  const data = {
    ...payload,
    images: normalizeImages(payload.images || []),
    ...(Object.prototype.hasOwnProperty.call(payload, 'sizeChartImage')
      ? { sizeChartImage: normalizeImageUrl(payload.sizeChartImage) }
      : {}),
    totalStock,
    reservedStock: 0,
    availableStock: totalStock,
    inStock: totalStock > 0,
    lowStockThreshold,
    createdAt: serverTimestamp(),
  }

  const docRef = await addDoc(productsCollection, data)
  invalidateProductsCache()
  return docRef.id
}

export async function editProduct(productId, payload) {
  const productRef = doc(db, 'products', productId)
  await updateDoc(productRef, {
    ...payload,
    images: normalizeImages(payload.images || []),
    ...(Object.prototype.hasOwnProperty.call(payload, 'sizeChartImage')
      ? { sizeChartImage: normalizeImageUrl(payload.sizeChartImage) }
      : {}),
  })
  invalidateProductsCache()
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
  let deleteResult
  try {
    deleteResult = await deleteTelegramMedia(body.images || [])
  } catch (error) {
    throw new Error(`Product deleted, but image cleanup failed: ${error.message}`)
  }
  invalidateProductsCache()
  return deleteResult
}
