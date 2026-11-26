import { createRateLimiter } from '../../server/rateLimit.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { createCheckoutReservation } from '../../server/reservationService.js'
import { reservationSchema } from '../../server/validation.js'

const limiter = createRateLimiter({ keyPrefix: 'reservation', windowMs: 60_000, max: 20 })

export default async function handler(req, res, {
  createReservation = createCheckoutReservation,
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

  const parse = reservationSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid reservation request', parse.error.format())

  try {
    const reservation = await createReservation(parse.data)
    res.setHeader('Content-Type', 'application/json')
    return res.status(200).end(JSON.stringify({ success: true, reservation }))
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return sendError(res, 409, error.message, { availableStock: error.availableStock })
    }
    if (error?.code === 'IDEMPOTENCY_CONFLICT') {
      res.statusCode = 409
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({
        success: false,
        code: error.code,
        message: error.message,
      }))
    }
    if (error?.code === 'PRODUCT_NOT_FOUND') return sendError(res, 404, error.message)
    if (error?.code === 'INVALID_QUANTITY') return sendError(res, 400, error.message)
    return sendError(res, 500, error?.message || 'Unable to reserve stock.')
  }
}
