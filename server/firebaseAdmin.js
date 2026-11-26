/* global process */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import {
  PERFORMANCE_PROJECT_ID,
  assertServerPerformanceConfiguration,
} from './performanceSafety.js'
import { createFirebaseAdminAppOptions } from './firebaseAdminConfig.js'

const isPerformanceMode = process.env.APP_MODE === 'performance' ||
  process.env.TELEGRAM_TEST_MODE === '1'

function loadLocalAdminEnvironment() {
  if (isPerformanceMode) {
    assertServerPerformanceConfiguration()
    return
  }
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
  const apps = getApps()
  if (apps.length) {
    if (isPerformanceMode && apps[0].options.projectId !== PERFORMANCE_PROJECT_ID) {
      throw new Error('Firebase Admin is already initialized for a non-performance project.')
    }
    return apps[0]
  }

  const appOptions = isPerformanceMode
    ? createFirebaseAdminAppOptions({
        performanceMode: true,
        env: process.env,
      })
    : createFirebaseAdminAppOptions({
        performanceMode: false,
        credential: buildCredential(),
      })
  const credentialSource = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? 'SERVICE_ACCOUNT_JSON'
    : process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
    ? 'CLIENT_EMAIL_KEY'
    : 'APPLICATION_DEFAULT'

  try {
    initializeApp(appOptions)
    if (isPerformanceMode) {
      console.log('Initialized Firebase Admin for the performance Emulator.')
    } else {
      console.log('Initialized Firebase Admin with credential source:', credentialSource)
    }
  } catch (e) {
    if (isPerformanceMode) {
      console.error('Failed to initialize Firebase Admin for the performance Emulator.')
    } else {
      console.error('Failed to initialize Firebase Admin:', e?.message || e)
    }
    throw e
  }

  return getApps()[0]
}

export const adminAuth = getAuth(getAdminApp())
