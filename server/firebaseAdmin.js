/* global process */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

function loadLocalAdminEnvironment() {
  if (process.env.NODE_ENV === 'production') return

  const envPath = resolve(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('Loading .env.local requires Node.js 20.12 or newer.')
  }

  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  delete process.env.FIREBASE_CLIENT_EMAIL
  delete process.env.FIREBASE_PRIVATE_KEY
  delete process.env.FIREBASE_PROJECT_ID
  process.loadEnvFile(envPath)
}

loadLocalAdminEnvironment()

function buildCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
    } catch {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON')
    }
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PROJECT_ID) {
    return cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Private key may contain \n sequences when loaded from env
      privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    })
  }

  return applicationDefault()
}

function getAdminApp() {
  if (!getApps().length) {
    const credentialSource = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? 'SERVICE_ACCOUNT_JSON'
      : process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
      ? 'CLIENT_EMAIL_KEY'
      : 'APPLICATION_DEFAULT'

    try {
      initializeApp({ credential: buildCredential() })
      console.log('Initialized Firebase Admin with credential source:', credentialSource)
    } catch (e) {
      console.error('Failed to initialize Firebase Admin:', e?.message || e)
      throw e
    }
  }
  return getApps()[0]
}

export const adminAuth = getAuth(getAdminApp())
