import { verifyAdmin } from '../../server/verifyAdmin.js'
import { sendError, setSecurityHeaders } from '../../server/http.js'
import { getStoreSettings, updateStoreWhatsAppNumber } from '../../server/storeSettings.js'

export default async function handler(req, res, {
  authenticateAdmin = verifyAdmin,
  readSettings = getStoreSettings,
  saveWhatsAppNumber = updateStoreWhatsAppNumber,
} = {}) {
  setSecurityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ success: true, settings: await readSettings() })
    } catch (error) {
      return sendError(res, 500, error?.message || 'Unable to load store settings.')
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return sendError(res, 405, 'Method Not Allowed')
  }

  const admin = await authenticateAdmin(req, res)
  if (!admin) return

  let body = req.body
  try {
    if (typeof body === 'string') body = JSON.parse(body)
  } catch {
    return sendError(res, 400, 'Invalid JSON body')
  }
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'whatsappNumber')
    || typeof body.whatsappNumber !== 'string'
  ) {
    return sendError(res, 400, 'Provide a WhatsApp number as text.')
  }

  try {
    const settings = await saveWhatsAppNumber(body.whatsappNumber)
    return res.status(200).json({ success: true, settings })
  } catch (error) {
    if (error?.code === 'INVALID_STORE_WHATSAPP_NUMBER') {
      return sendError(res, 400, error.message)
    }
    return sendError(res, 500, error?.message || 'Unable to update store settings.')
  }
}
