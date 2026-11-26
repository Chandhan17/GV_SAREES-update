import process from 'node:process'
import {
  PERFORMANCE_AUTH_HOST,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
} from './performanceSafety.js'

export function createFirebaseAdminAppOptions({
  performanceMode,
  env = process.env,
  credential,
}) {
  if (!performanceMode) return { credential }

  if (env.FIREBASE_PROJECT_ID !== PERFORMANCE_PROJECT_ID ||
      env.FIRESTORE_EMULATOR_HOST !== PERFORMANCE_FIRESTORE_HOST ||
      env.FIREBASE_AUTH_EMULATOR_HOST !== PERFORMANCE_AUTH_HOST) {
    throw new Error('Firebase Admin performance configuration is not emulator-only.')
  }

  return { projectId: PERFORMANCE_PROJECT_ID }
}
