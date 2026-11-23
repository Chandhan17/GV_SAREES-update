import { getFirestore } from 'firebase-admin/firestore'
import { adminAuth } from './firebaseAdmin.js'
import { isAuthorizedAdminRecord } from './adminAuthorization.js'

function jsonError(res, statusCode, message) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ success: false, message }))
}

export function getBearerToken(req) {
  const header = String(req.headers?.authorization || '')
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

export async function verifyAdmin(req, res) {
  const token = getBearerToken(req)
  if (!token) {
    jsonError(res, 401, 'Unauthorized: Missing token')
    return null
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token)
    const adminSnapshot = await getFirestore().collection('admins').doc(decoded.uid).get()
    if (!isAuthorizedAdminRecord(adminSnapshot)) {
      jsonError(res, 401, 'Unauthorized: Admin access required')
      return null
    }

    req.user = { uid: decoded.uid, email: String(decoded.email || '').toLowerCase() }
    return req.user
  } catch {
    jsonError(res, 401, 'Unauthorized: Invalid token')
    return null
  }
}
