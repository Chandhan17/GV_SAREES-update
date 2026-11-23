import { Timestamp } from 'firebase-admin/firestore'
import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { db } from '../../server/reservationService.js'
import { adjustInventory, setInventoryThreshold } from '../../server/inventory.js'
import { inventoryAdjustmentSchema } from '../../server/validation.js'

export default async function handler(req, res) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  const admin = await verifyAdmin(req, res)
  if (!admin) return

  let body = req.body
  try {
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  const parse = inventoryAdjustmentSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid inventory request', parse.error.format())

  try {
    const result = await db.runTransaction(async (transaction) => {
      const productRef = db.collection('products').doc(parse.data.productId)
      const snapshot = await transaction.get(productRef)
      if (!snapshot.exists) throw Object.assign(new Error('Product not found.'), { code: 'PRODUCT_NOT_FOUND' })
      const product = snapshot.data()
      const previous = Number.isInteger(product.totalStock) ? product.totalStock : 0
      const inventory = parse.data.action === 'adjust'
        ? adjustInventory(product, parse.data.quantityChange, parse.data.lowStockThreshold)
        : setInventoryThreshold(product, parse.data.lowStockThreshold)
      const now = Timestamp.now()
      transaction.update(productRef, inventory)
      transaction.set(db.collection('inventoryHistory').doc(), {
        productId: parse.data.productId,
        actionType: parse.data.action === 'adjust' ? 'adjust' : 'threshold',
        quantityChanged: parse.data.action === 'adjust' ? parse.data.quantityChange : 0,
        previousQuantity: previous,
        newQuantity: inventory.totalStock,
        reason: parse.data.reason,
        adminUid: admin.uid,
        timestamp: now,
      })
      return inventory
    })
    return res.status(200).json({ success: true, inventory: result })
  } catch (error) {
    const status = error?.code === 'INVALID_LOW_STOCK_THRESHOLD' ? 400
      : ['PRODUCT_NOT_FOUND', 'INVALID_ADJUSTMENT', 'RESERVED_STOCK_PROTECTED'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to update inventory.')
  }
}
