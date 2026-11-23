import { sendError, setSecurityHeaders } from '../../server/http.js'
import { createRateLimiter } from '../../server/rateLimit.js'
import { cancelReservation } from '../../server/reservationService.js'
import { customerReservationCancellationSchema } from '../../server/validation.js'

const limiter = createRateLimiter({ keyPrefix: 'reservation-cancel', windowMs: 60_000, max: 20 })

export default async function handler(req, res) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  if (!limiter(req, res)) return

  let body = req.body
  try {
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  const parse = customerReservationCancellationSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid cancellation request')

  try {
    const result = await cancelReservation(parse.data.reservationId, parse.data.cancellationToken)
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    const status = error?.code === 'INVALID_CANCELLATION_TOKEN' ? 403 : ['RESERVATION_NOT_FOUND', 'RESERVATION_CONVERTED'].includes(error?.code) ? 409 : 500
    return sendError(res, status, error?.message || 'Unable to cancel reservation.')
  }
}
