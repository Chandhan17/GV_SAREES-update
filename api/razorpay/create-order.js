import { sendError, setSecurityHeaders } from '../../server/http.js'
import { createRateLimiter } from '../../server/rateLimit.js'
import { createRazorpayPaymentOrder } from '../../server/razorpayPaymentService.js'
import { razorpayOrderSchema } from '../../server/validation.js'

const limiter = createRateLimiter({ keyPrefix: 'razorpay-create', windowMs: 60_000, max: 10 })

export default async function handler(req, res, {
  createPaymentOrder = createRazorpayPaymentOrder,
  rateLimit = limiter,
} = {}) {
  setSecurityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
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
  const parse = razorpayOrderSchema.safeParse(body || {})
  if (!parse.success) return sendError(res, 400, 'Invalid Razorpay payment order request')

  try {
    const result = await createPaymentOrder(parse.data)
    return res.status(200).json({
      keyId: result.keyId,
      razorpayOrderId: result.razorpayOrderId,
      amount: result.amount,
      currency: result.currency,
    })
  } catch (error) {
    const status = error?.code === 'PAYMENT_NOT_CONFIGURED' || error?.code === 'TEST_MODE_REQUIRED'
      ? 503
      : error?.code === 'PAYMENT_PROVIDER_ERROR'
        ? 502
        : error?.code === 'INVALID_RESERVATION_TOKEN'
          ? 403
          : error?.code === 'RESERVATION_NOT_FOUND' || error?.code === 'PRODUCT_NOT_FOUND'
            ? 404
            : error?.code === 'INVALID_QUANTITY'
              ? 400
              : error?.code === 'PAYMENT_ORDER_IN_PROGRESS'
                ? 503
                : error?.code
                  ? 409
                  : 500
    const message = status === 500
      ? 'Unable to create the Razorpay payment order.'
      : error?.message || 'Unable to create the Razorpay payment order.'
    return sendError(res, status, message)
  }
}
