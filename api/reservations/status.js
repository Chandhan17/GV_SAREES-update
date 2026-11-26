import { createRateLimiter } from '../../server/rateLimit.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { getCustomerReservationStatus } from '../../server/reservationService.js'
import { customerReservationCancellationSchema } from '../../server/validation.js'

const limiter = createRateLimiter({ keyPrefix: 'reservation-status', windowMs: 60_000, max: 30 })

export default async function handler(req, res, {
  getStatus = getCustomerReservationStatus,
  rateLimit = limiter,
} = {}) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  if (!rateLimit(req, res)) return

  let body = req.body
  try {
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  const parse = customerReservationCancellationSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid reservation lookup')

  try {
    const reservation = await getStatus(parse.data.reservationId, parse.data.cancellationToken)
    return res.status(200).json({ success: true, reservation })
  } catch (error) {
    const status = error?.code === 'INVALID_CANCELLATION_TOKEN'
      ? 403
      : error?.code === 'RESERVATION_NOT_FOUND'
        ? 404
        : 500
    return sendError(res, status, error?.message || 'Unable to retrieve reservation status.')
  }
}
