import { sendError, setSecurityHeaders } from '../../server/http.js'
import { expireReservation, getReservationOrders } from '../../server/reservationService.js'
import { processExpiryPages } from '../../server/expiryCleanup.js'
import { cronSecretMatches } from '../../server/cronAuth.js'

function isAuthorized(req) {
  const expected = String(process.env.CRON_SECRET || '')
  const auth = String(req.headers?.authorization || '')
  const header = String(req.headers?.['x-cron-secret'] || '')
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  return cronSecretMatches(expected, header) || cronSecretMatches(expected, bearer)
}

export default async function handler(req, res) {
  setSecurityHeaders(res)
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST')
    return sendError(res, 405, 'Method Not Allowed')
  }
  if (!isAuthorized(req)) return sendError(res, 401, 'Unauthorized cleanup request')

  try {
    const result = await processExpiryPages(
      async ({ cursor, limit }) => {
        const snapshot = await getReservationOrders({ after: cursor, limit })
        return snapshot.docs
      },
      async (order) => {
        try {
          return await expireReservation(order)
        } catch (error) {
          console.error('Reservation expiry failed:', order.id, error?.message || error)
          throw error
        }
      },
      { pageSize: 50, maxPages: 10 },
    )
    return res.status(200).json({ success: result.failed === 0, ...result })
  } catch (error) {
    return sendError(res, 500, error?.message || 'Unable to clean up reservations.')
  }
}
