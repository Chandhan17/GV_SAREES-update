import {
  createTelegramImageHandler,
  logUploadRequestDiagnostics,
} from './_lib/telegramUpload.js'
import { verifyAdmin } from '../server/verifyAdmin.js'
import { createRateLimiter } from '../server/rateLimit.js'
import { setSecurityHeaders, sendError } from '../server/http.js'
import {
  assertServerPerformanceConfiguration,
  verifyFirestoreEmulator,
  verifyTelegramTestResources,
} from '../server/performanceSafety.js'

const uploadLimiter = createRateLimiter({ keyPrefix: 'upload', windowMs: 60_000, max: 20 })

export const config = {
  api: {
    bodyParser: false,
  },
}

export default async function handler(req, res) {
  logUploadRequestDiagnostics(req, 'vercel route entry')
  setSecurityHeaders(res)

  if (process.env.APP_MODE === 'performance' || process.env.TELEGRAM_TEST_MODE === '1') {
    try {
      assertServerPerformanceConfiguration()
      await verifyFirestoreEmulator({
        projectId: process.env.FIREBASE_PROJECT_ID,
        emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      })
      await verifyTelegramTestResources({
        telegramToken: process.env.TELEGRAM_BOT_TOKEN,
        telegramUsername: String(process.env.TELEGRAM_TEST_BOT_USERNAME || '')
          .replace(/^@/, '')
          .toLowerCase(),
        telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,
      })
    } catch {
      return sendError(res, 503, 'Performance safety checks failed; upload was blocked.')
    }
  }

  // Verify admin token
  const user = await verifyAdmin(req, res)
  if (!user) return

  // Rate limit uploads
  if (!uploadLimiter(req, res)) return

  // Delegate to existing handler
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHANNEL_ID) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID in env for uploads')
    return sendError(res, 500, 'Server configuration error')
  }

  return createTelegramImageHandler({
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,
  })(req, res)
}