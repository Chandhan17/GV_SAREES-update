import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { createRateLimiter } from '../../server/rateLimit.js'
import {
  getRazorpayPaymentConfiguration,
  processRazorpayRefund,
} from '../../server/razorpayPaymentService.js'
import {
  getRazorpayWebhookSecret,
  processRazorpayWebhookEvent,
  verifyRazorpayWebhookSignature,
} from '../../server/razorpayWebhookService.js'

const MAX_WEBHOOK_BODY_BYTES = 1_000_000
const limiter = createRateLimiter({ keyPrefix: 'razorpay-webhook', windowMs: 60_000, max: 120 })

function createStageLogger() {
  const startedAt = performance.now()
  return (stage) => {
    console.info('razorpay_webhook_stage', stage, `${Math.round(performance.now() - startedAt)}ms`)
  }
}

export const config = {
  api: { bodyParser: false },
}

async function getRawRequestBody(req) {
  const rawBody = req.rawBody
  if (Buffer.isBuffer(rawBody)) return rawBody
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody)
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8')

  if (typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      const chunks = []
      let length = 0
      let settled = false
      req.on('data', (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += buffer.length
        if (length > MAX_WEBHOOK_BODY_BYTES) {
          settled = true
          reject(Object.assign(new Error('Webhook payload is too large.'), { code: 'WEBHOOK_BODY_TOO_LARGE' }))
          return
        }
        chunks.push(buffer)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, length))
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  }

  if (Buffer.isBuffer(req.body)) return req.body
  if (req.body instanceof Uint8Array) return Buffer.from(req.body)
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8')
  return null
}

export default async function handler(req, res, {
  webhookSecret,
  processEvent = processRazorpayWebhookEvent,
  getTestConfiguration = getRazorpayPaymentConfiguration,
  rateLimit = limiter,
} = {}) {
  const logStage = createStageLogger()
  setSecurityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
  const respondWithError = (status, message) => {
    logStage(`http_response:${status}`)
    return sendError(res, status, message)
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return respondWithError(405, 'Method Not Allowed')
  }
  if (!rateLimit(req, res)) {
    logStage('http_response:rate_limited')
    return
  }

  const signature = req.headers?.['x-razorpay-signature']
  const eventId = req.headers?.['x-razorpay-event-id']
  if (typeof signature !== 'string') return respondWithError(400, 'Missing Razorpay webhook signature.')
  if (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) {
    return respondWithError(400, 'Missing or invalid Razorpay webhook event ID.')
  }
  let secret = webhookSecret
  if (secret === undefined) {
    try {
      secret = getRazorpayWebhookSecret()
    } catch {
      return respondWithError(503, 'Razorpay webhook verification is not configured.')
    }
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    return respondWithError(503, 'Razorpay webhook verification is not configured.')
  }

  let rawBody
  logStage('raw_body_read:start')
  try {
    rawBody = await getRawRequestBody(req)
    logStage('raw_body_read:complete')
  } catch (error) {
    logStage('raw_body_read:error')
    const status = error?.code === 'WEBHOOK_BODY_TOO_LARGE' ? 413 : 400
    return respondWithError(status, error?.message || 'Unable to read the raw webhook payload.')
  }
  if (!rawBody || rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return respondWithError(rawBody ? 413 : 400, 'Raw webhook payload is unavailable or invalid.')
  }
  logStage('signature_verification:start')
  const signatureValid = verifyRazorpayWebhookSignature(rawBody, signature, secret)
  logStage('signature_verification:complete')
  if (!signatureValid) return respondWithError(403, 'Invalid Razorpay webhook signature.')

  let eventPayload
  logStage('event_parsing:start')
  try {
    eventPayload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    logStage('event_parsing:error')
    return respondWithError(400, 'Invalid webhook JSON payload.')
  }
  logStage('event_parsing:complete')
  if (
    !eventPayload
    || typeof eventPayload.event !== 'string'
    || !eventPayload.payload
    || typeof eventPayload.payload !== 'object'
  ) {
    return respondWithError(400, 'Invalid Razorpay webhook event payload.')
  }

  try {
    getTestConfiguration()
    logStage('event_processing:start')
    const result = await processEvent({
      eventId,
      event: eventPayload.event,
      payload: eventPayload.payload,
    }, { onStage: logStage })
    if (result?.refundRequired && result.reservationId) {
      try {
        await processRazorpayRefund({
          reservationId: result.reservationId,
          paymentId: result.paymentId,
          amount: result.amount,
          reason: 'Captured payment could not be fulfilled because inventory was unavailable',
        })
      } catch (refundError) {
        console.error('[razorpay-refund] automatic webhook refund failed', refundError?.code || refundError?.message)
      }
    }
    logStage('event_processing:complete')
    logStage('http_response:200')
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    const status = [
      'PAYMENT_ORDER_NOT_FOUND',
      'PAYMENT_PROVIDER_ERROR',
      'PAYMENT_PROVIDER_TIMEOUT',
      'PAYMENT_NOT_CONFIGURED',
      'TEST_MODE_REQUIRED',
    ].includes(error?.code)
      ? 503
      : error?.code === 'INVALID_WEBHOOK_EVENT' || error?.code === 'PAYMENT_DETAILS_MISMATCH'
        ? 400
        : error?.code
          ? 409
          : 500
    const message = status === 500
      ? 'Unable to process the Razorpay webhook.'
      : error?.message || 'Unable to process the Razorpay webhook.'
    logStage(`http_response:${status}`)
    return sendError(res, status, message)
  }
}
