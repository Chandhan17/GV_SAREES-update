import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { expireReservationById, releaseReservation, restockConvertedOrder } from '../../server/reservationService.js'
import { processRazorpayRefund } from '../../server/razorpayPaymentService.js'
import { adminReservationSchema } from '../../server/validation.js'

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
  const parse = adminReservationSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid reservation action', parse.error.format())

  try {
    const result = parse.data.action === 'expire'
        ? { status: await expireReservationById(parse.data.reservationId) ? 'expired' : 'active' }
        : parse.data.action === 'retry-refund'
        ? await processRazorpayRefund({
          reservationId: parse.data.reservationId,
          paymentId: '',
          amount: 0,
        })
        : parse.data.action === 'restock-cancelled'
        ? await restockConvertedOrder(parse.data.reservationId, admin.uid, parse.data.reason || 'Converted order cancelled and restocked')
        : await releaseReservation(parse.data.reservationId, admin.uid, parse.data.reason || 'Released by admin')
    if (result.status === 'expired') {
      return sendError(res, 409, 'This checkout hold has expired.')
    }
    if (result.status === 'manual_review') {
      return sendError(res, 409, 'Payment was captured, but inventory is unavailable. The order requires manual resolution or a verified refund.')
    }
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    const status = error?.code === 'PAYMENT_STATUS_UNAVAILABLE'
      ? 503
      : ['INSUFFICIENT_STOCK', 'RESERVATION_NOT_FOUND', 'RESERVATION_NOT_ACTIVE', 'RESERVATION_EXPIRED', 'RESERVATION_CONVERTED', 'RESERVATION_STATUS_INCONSISTENT', 'PAYMENT_IN_PROGRESS', 'PAYMENT_CAPTURED', 'PAYMENT_NOT_CAPTURED', 'PAYMENT_REQUIRES_REFUND'].includes(error?.code)
        ? 409
        : 500
    return sendError(res, status, error?.message || 'Unable to update reservation.')
  }
}
