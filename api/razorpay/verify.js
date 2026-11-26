import { sendError, setSecurityHeaders } from '../../server/http.js'
import { createRateLimiter } from '../../server/rateLimit.js'
import {
  abandonRazorpayCheckout,
  processRazorpayRefund,
  recordRazorpayPaymentFailure,
  verifyRazorpayPayment,
} from '../../server/razorpayPaymentService.js'
import {
  razorpayDismissalSchema,
  razorpayFailureSchema,
  razorpayVerificationSchema,
} from '../../server/validation.js'

const limiter = createRateLimiter({ keyPrefix: 'razorpay-verify', windowMs: 60_000, max: 20 })

export default async function handler(req, res, {
  verifyPayment = verifyRazorpayPayment,
  recordFailure = recordRazorpayPaymentFailure,
  abandonCheckout = abandonRazorpayCheckout,
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
  const verification = razorpayVerificationSchema.safeParse(body || {})
  const dismissal = verification.success ? null : razorpayDismissalSchema.safeParse(body || {})
  const failure = verification.success || dismissal?.success ? null : razorpayFailureSchema.safeParse(body || {})
  if (!verification.success && !dismissal?.success && !failure?.success) {
    return sendError(res, 400, 'Invalid Razorpay payment verification request')
  }

  try {
    const result = verification.success
      ? await verifyPayment(verification.data)
      : dismissal?.success
        ? await abandonCheckout(dismissal.data)
        : await recordFailure(failure.data)
    if (verification.success && result?.refundRequired) {
      try {
        await processRazorpayRefund({
          reservationId: result.reservationId,
          paymentId: result.paymentId,
          amount: result.amount,
          reason: 'Captured payment could not be fulfilled because inventory was unavailable',
        })
      } catch (refundError) {
        console.error('[razorpay-refund] automatic refund request failed', refundError?.code || refundError?.message)
      }
    }
    return res.status(200).json({
      status: result.status,
      ...(result.inventoryStatus ? { inventoryStatus: result.inventoryStatus } : {}),
      ...(result.paymentOutcome ? { paymentOutcome: result.paymentOutcome } : {}),
      ...(result.releaseOperationResult ? { releaseOperationResult: result.releaseOperationResult } : {}),
    })
  } catch (error) {
    const status = error?.code === 'PAYMENT_NOT_CONFIGURED'
      || error?.code === 'TEST_MODE_REQUIRED'
      || error?.code === 'PAYMENT_STATUS_UNAVAILABLE'
      ? 503
      : error?.code === 'PAYMENT_PROVIDER_ERROR'
        ? 502
        : error?.code === 'INVALID_PAYMENT_SIGNATURE'
          || error?.code === 'INVALID_RESERVATION_TOKEN'
          ? 403
          : error?.code === 'PAYMENT_ORDER_NOT_FOUND'
            ? 404
            : error?.code
              ? 409
              : 500
    const message = status === 500
      ? 'Unable to verify the Razorpay payment.'
      : error?.message || 'Unable to verify the Razorpay payment.'
    return sendError(res, status, message)
  }
}
