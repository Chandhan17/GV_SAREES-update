import { sendError, setSecurityHeaders } from './http.js'

export function telegramMediaDeletionDisabled(_req, res) {
  setSecurityHeaders(res)
  return sendError(res, 503, 'Telegram media deletion is temporarily disabled.')
}
