import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { assertOrderCanArchive, validateOrderStatusTransition } from '../../server/orderPolicy.js'
import { confirmReservation, db } from '../../server/reservationService.js'
import { adminOrderActionSchema } from '../../server/validation.js'
import { Timestamp } from 'firebase-admin/firestore'

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
  const parse = adminOrderActionSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid order action', parse.error.format())

  try {
    const ref = db.collection('orders').doc(parse.data.orderId)
    if (parse.data.action === 'status') {
      const current = await ref.get()
      if (!current.exists) return sendError(res, 404, 'Order not found.')
      const order = current.data()
      if (order.reservationId && parse.data.orderStatus === 'confirmed') {
        const result = await confirmReservation(order.reservationId, admin.uid)
        if (result.status === 'expired') return sendError(res, 409, 'This reservation has expired and cannot be confirmed.')
        return res.status(200).json({ success: true, orderStatus: 'confirmed' })
      }

      const updated = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists) throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
        const latest = snapshot.data()
        validateOrderStatusTransition(latest, parse.data.orderStatus)
        transaction.update(ref, { orderStatus: parse.data.orderStatus })
        return parse.data.orderStatus
      })
      return res.status(200).json({ success: true, orderStatus: updated })
    }

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists) throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
      const order = snapshot.data()
      assertOrderCanArchive(order)
      if (!order.archived) {
        transaction.update(ref, { archived: true, archivedAt: Timestamp.now(), archivedBy: admin.uid })
      }
    })
    return res.status(200).json({ success: true, archived: true })
  } catch (error) {
    const status = ['ACTIVE_RESERVATION', 'RESERVATION_ACTION_REQUIRED', 'RESERVATION_NOT_CONVERTED', 'RESERVATION_NOT_ACTIVE', 'INVALID_ORDER_TRANSITION', 'INVALID_ORDER_STATUS', 'ORDER_NOT_FOUND'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to update order.')
  }
}
