import { sendError, setSecurityHeaders } from '../../server/http.js'

export default function handler(req, res) {
  setSecurityHeaders(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  return sendError(res, 410, 'Razorpay checkout is disabled until server-side reservations, payment verification, and webhooks are implemented.')
}
