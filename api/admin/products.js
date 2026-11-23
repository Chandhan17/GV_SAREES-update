import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { db } from '../../server/reservationService.js'
import { z } from 'zod'

const deleteSchema = z.object({
  action: z.literal('delete'),
  productId: z.string().min(1).max(128),
})

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
  const parse = deleteSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid product action')

  try {
    const productRef = db.collection('products').doc(parse.data.productId)
    const images = await db.runTransaction(async (transaction) => {
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
