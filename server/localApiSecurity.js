import { setSecurityHeaders, sendError } from './http.js'

export function createProtectedLocalHandler({
  verifyAdmin,
  limiter,
  validateRequest,
  missingCredentialsMessage,
  hasRequiredCredentials,
  delegate,
}) {
  return async function protectedLocalHandler(req, res) {
    setSecurityHeaders(res)

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendError(res, 405, 'Method Not Allowed')
    }

    const user = await verifyAdmin(req, res)
    if (!user) return

    if (!limiter(req, res)) return

    if (validateRequest) {
      const validation = await validateRequest(req, res)
      if (!validation) return
    }

    if (!hasRequiredCredentials()) {
      return sendError(res, 500, missingCredentialsMessage)
    }

    return delegate(req, res)
  }
}
