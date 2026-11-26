import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { assertOrderCanArchive, validateOrderStatusTransition } from '../../server/orderPolicy.js'
import { db, releaseReservation, restockConvertedOrder } from '../../server/reservationService.js'
import { deleteOrders, permanentlyDeleteOrders } from '../../server/orderDeletionService.js'
import { adminOrderActionSchema } from '../../server/validation.js'
import { Timestamp } from 'firebase-admin/firestore'

export default async function handler(req, res, {
  authenticateAdmin = verifyAdmin,
  firestore = db,
  timestamp = Timestamp,
} = {}) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  const admin = await authenticateAdmin(req, res)
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
    if (parse.data.action === 'delete') {
      const result = await deleteOrders(parse.data.orderIds, admin.uid, { firestore, timestamp })
      return res.status(200).json({ success: result.failed.length === 0, ...result })
    }
    if (parse.data.action === 'permanent-delete') {
      const result = await permanentlyDeleteOrders(parse.data.orderIds, admin.uid, { firestore, timestamp })
      return res.status(200).json({
        success: result.failed.length === 0,
        backupDisposition: parse.data.backupDisposition,
        ...result,
      })
    }

    const ref = firestore.collection('orders').doc(parse.data.orderId)
    if (parse.data.action === 'status') {
      const current = await ref.get()
      if (!current.exists) return sendError(res, 404, 'Order not found.')
      const order = current.data()
      if (parse.data.orderStatus === 'cancelled') {
        validateOrderStatusTransition(order, 'cancelled')
        if (order.reservationId && order.reservationStatus === 'converted' && !order.stockRestored) {
          const result = await restockConvertedOrder(
            order.reservationId,
            admin.uid,
            'Order cancelled by admin after payment resolution',
            { firestore, timestamp },
          )
          return res.status(200).json({
            success: true,
            orderId: result.orderId,
            orderStatus: result.orderStatus,
          })
        }
        if (order.reservationId && order.reservationStatus === 'active') {
          await releaseReservation(
            order.reservationId,
            admin.uid,
            'Order cancelled by admin',
            { firestore, timestamp },
          )
        }
      }

      const updated = await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists) throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
        const latest = snapshot.data()
        validateOrderStatusTransition(latest, parse.data.orderStatus)
        transaction.update(ref, { orderStatus: parse.data.orderStatus })
        return parse.data.orderStatus
      })
      return res.status(200).json({ success: true, orderId: parse.data.orderId, orderStatus: updated })
    }

    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists) throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
      const order = snapshot.data()
      assertOrderCanArchive(order)
      if (!order.archived) {
        transaction.update(ref, { archived: true, archivedAt: timestamp.now(), archivedBy: admin.uid })
      }
    })
    return res.status(200).json({ success: true, archived: true })
  } catch (error) {
    const status = ['INSUFFICIENT_STOCK', 'ACTIVE_RESERVATION', 'RESERVATION_ACTION_REQUIRED', 'RESERVATION_NOT_CONVERTED', 'RESERVATION_NOT_ACTIVE', 'RESERVATION_CONVERTED', 'RESERVATION_STATUS_INCONSISTENT', 'INVALID_ORDER_TRANSITION', 'INVALID_ORDER_STATUS', 'ORDER_NOT_FOUND', 'PAYMENT_NOT_CAPTURED', 'PAYMENT_REQUIRES_REFUND', 'AUTOMATIC_CONFIRMATION_REQUIRED', 'PAYMENT_IN_PROGRESS', 'PAYMENT_CAPTURED'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to update order.')
  }
}
