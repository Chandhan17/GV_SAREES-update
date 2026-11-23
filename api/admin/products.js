import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { db } from '../../server/reservationService.js'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeImageUrl, normalizeImages } from '../../src/utils/imageHelpers.js'
import { productCreateSchema, productUpdateSchema } from '../../server/validation.js'

const deleteSchema = z.object({
  action: z.literal('delete'),
  productId: z.string().min(1).max(128),
})

export function normalizeProductCreatePayload(parseData) {
  const totalStock = parseData.totalStock
  const images = normalizeImages(parseData.images)
  if (!images.length) {
    throw Object.assign(new Error('At least one valid product image is required.'), { code: 'INVALID_IMAGES' })
  }

  return {
    name: parseData.name,
    price: parseData.price,
    category: parseData.category,
    description: parseData.description,
    fabric: parseData.fabric,
    images,
    sizeLength: parseData.sizeLength,
    sizeChartText: parseData.sizeChartText,
    ...(Object.prototype.hasOwnProperty.call(parseData, 'sizeChartImage')
      ? { sizeChartImage: normalizeImageUrl(parseData.sizeChartImage) }
      : {}),
    totalStock,
    reservedStock: 0,
    availableStock: totalStock,
    inStock: totalStock > 0,
    lowStockThreshold: parseData.lowStockThreshold,
    createdAt: FieldValue.serverTimestamp(),
  }
}

export function getIdempotencyKey(req) {
  const headers = req.headers || {}
  const primary = headers['idempotency-key']
  const alternate = headers['x-idempotency-key']
  const normalize = (value) => {
    if (Array.isArray(value)) return value.length === 1 ? value[0] : null
    return typeof value === 'string' ? value : null
  }

  const primaryKey = normalize(primary)
  const alternateKey = normalize(alternate)

  if (primaryKey !== null && alternateKey !== null && primaryKey !== alternateKey) {
    throw Object.assign(new Error('Conflicting idempotency headers.'), { code: 'IDEMPOTENCY_HEADER_CONFLICT' })
  }

  const key = primaryKey !== null ? primaryKey : alternateKey
  if (!key) {
    throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { code: 'IDEMPOTENCY_KEY_REQUIRED' })
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw Object.assign(new Error('Invalid idempotency key.'), { code: 'IDEMPOTENCY_KEY_INVALID' })
  }
  return key
}

export function getAdminIdempotencyDocumentId(adminUid, idempotencyKey) {
  return createHash('sha256')
    .update(`${adminUid}\0${idempotencyKey}`)
    .digest('hex')
}

export function createAdminProductsHandler({
  verifyAdminUser = verifyAdmin,
  firestore = db,
  parseBody = (req) => req.body,
} = {}) {
  return async function adminProductsHandler(req, res) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  const admin = await verifyAdminUser(req, res)
  if (!admin) return

  let body = parseBody(req)
  try {
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  if (body?.action === 'create') {
    const parse = productCreateSchema.safeParse(body)
    if (!parse.success) return sendError(res, 400, 'Invalid product request', parse.error.format())

    let data
    try {
      data = normalizeProductCreatePayload(parse.data)
    } catch (error) {
      return sendError(res, 400, error?.message || 'Invalid product request')
    }

    let idempotencyKey
    try {
      idempotencyKey = getIdempotencyKey(req)
    } catch (error) {
      return sendError(res, 400, error.message)
    }

    const fingerprint = createHash('sha256').update(JSON.stringify(parse.data)).digest('hex')

    try {
      const idempotencyDocumentId = getAdminIdempotencyDocumentId(admin.uid, idempotencyKey)
      const requestRef = firestore.collection('productCreationRequests').doc(idempotencyDocumentId)
      const productId = await firestore.runTransaction(async (transaction) => {
        const requestSnapshot = await transaction.get(requestRef)
        if (requestSnapshot.exists) {
          const existing = requestSnapshot.data()
          if (existing.fingerprint !== fingerprint) {
            throw Object.assign(new Error('This idempotency key was used for a different product request.'), { code: 'IDEMPOTENCY_CONFLICT' })
          }
          const existingProduct = await transaction.get(firestore.collection('products').doc(existing.productId))
          if (!existingProduct.exists) {
            throw Object.assign(new Error('The previous product creation did not complete.'), { code: 'IDEMPOTENCY_PENDING' })
          }
          return existing.productId
        }

        const productRef = firestore.collection('products').doc()
        transaction.set(productRef, data)
        transaction.set(requestRef, {
          productId: productRef.id,
          fingerprint,
          adminUid: admin.uid,
          createdAt: Timestamp.now(),
        })
        return productRef.id
      })

      return res.status(201).json({ success: true, productId })
    } catch (error) {
      if (error?.code === 'IDEMPOTENCY_CONFLICT') return sendError(res, 409, error.message)
      if (error?.code === 'IDEMPOTENCY_PENDING') return sendError(res, 409, error.message)
      return sendError(res, 500, 'Unable to create product.')
    }
  }

  if (body?.action === 'update') {
    const parse = productUpdateSchema.safeParse(body)
    if (!parse.success) return sendError(res, 400, 'Invalid product update request', parse.error.format())

    const updates = { ...parse.data }
    delete updates.action
    delete updates.productId

    if (Object.prototype.hasOwnProperty.call(updates, 'images')) {
      const images = normalizeImages(updates.images)
      if (!images.length) return sendError(res, 400, 'At least one valid product image is required.')
      updates.images = images
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sizeChartImage')) {
      updates.sizeChartImage = normalizeImageUrl(updates.sizeChartImage)
    }

    try {
      await firestore.runTransaction(async (transaction) => {
        const productRef = firestore.collection('products').doc(parse.data.productId)
        const snapshot = await transaction.get(productRef)
        if (!snapshot.exists) {
          throw Object.assign(new Error('Product not found.'), { code: 'PRODUCT_NOT_FOUND' })
        }
        transaction.update(productRef, updates)
      })
      return res.status(200).json({ success: true, productId: parse.data.productId })
    } catch (error) {
      if (error?.code === 'PRODUCT_NOT_FOUND') {
        return sendError(res, 404, error.message)
      }
      return sendError(res, 500, 'Unable to update product.')
    }
  }

  const parse = deleteSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid product action')

  try {
    const productRef = firestore.collection('products').doc(parse.data.productId)
    const images = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(productRef)
      if (!snapshot.exists) throw Object.assign(new Error('Product not found.'), { code: 'PRODUCT_NOT_FOUND' })
      const product = snapshot.data()
      if ((Number(product.reservedStock) || 0) > 0) {
        throw Object.assign(new Error('Product cannot be deleted while stock is reserved.'), { code: 'ACTIVE_RESERVATIONS' })
      }
      transaction.delete(productRef)
      return product.images || []
    })
    return res.status(200).json({ success: true, images })
  } catch (error) {
    const status = ['PRODUCT_NOT_FOUND', 'ACTIVE_RESERVATIONS'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to delete product.')
  }
}
}

export default createAdminProductsHandler()
