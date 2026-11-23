import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { confirmReservation, expireReservationById, releaseReservation, restockConvertedOrder } from '../../server/reservationService.js'
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
    const result = parse.data.action === 'confirm'
      ? await confirmReservation(parse.data.reservationId, admin.uid)
      : parse.data.action === 'expire'
        ? { status: await expireReservationById(parse.data.reservationId) ? 'expired' : 'active' }
        : parse.data.action === 'restock-cancelled'
        ? await restockConvertedOrder(parse.data.reservationId, admin.uid, parse.data.reason || 'Converted order cancelled and restocked')
        : await releaseReservation(parse.data.reservationId, admin.uid, parse.data.reason || 'Released by admin')
    if (result.status === 'expired') {
      return sendError(res, 409, 'This reservation has expired and cannot be confirmed.')
    }
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    const status = ['RESERVATION_NOT_FOUND', 'RESERVATION_NOT_ACTIVE', 'RESERVATION_EXPIRED', 'RESERVATION_CONVERTED'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to update reservation.')
  }
}
