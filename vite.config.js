import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import {
  createTelegramImageHandler,
  createTelegramImageProxyHandler,
} from './api/_lib/telegramUpload.js'
import { createRateLimiter } from './server/rateLimit.js'
import { createProtectedLocalHandler } from './server/localApiSecurity.js'
import { telegramMediaDeletionDisabled } from './server/telegramMediaDeletionDisabled.js'
import { createApiProxyConfig } from './server/apiProxyConfig.js'
import {
  PERFORMANCE_API_TARGET,
  assertServerPerformanceConfiguration,
  createPerformanceWriteGuard,
  readProductionTelegramEnvironments,
  readPerformanceEnvironment,
  resolvePerformanceEnvironment,
  validatePerformanceConfiguration,
  verifyFirestoreEmulator,
  verifyPerformanceWriteSafety,
  verifyTelegramTestResources,
} from './server/performanceSafety.js'

function localTelegramUploadApi({
  telegramToken,
  telegramChannelId,
  performanceMode,
  apiTarget,
}) {
  return {
    name: 'local-telegram-upload-api',
    async configureServer(server) {
      const { verifyAdmin } = await import('./server/verifyAdmin.js')
      const proxyHandler = createTelegramImageProxyHandler({ telegramToken })
      const uploadLimiter = createRateLimiter({ keyPrefix: 'upload', windowMs: 60_000, max: 20 })

      if (performanceMode) {
        server.middlewares.use('/api', createPerformanceWriteGuard({
          verify: () => verifyPerformanceWriteSafety({ apiTarget }),
        }))
      }

      const uploadHandler = createProtectedLocalHandler({
        verifyAdmin,
        limiter: uploadLimiter,
        missingCredentialsMessage: 'Server configuration error',
        hasRequiredCredentials: () => Boolean(telegramToken && telegramChannelId),
        delegate: createTelegramImageHandler({ telegramToken, telegramChannelId }),
      })

      server.middlewares.use('/api/upload-image', uploadHandler)
      server.middlewares.use('/api/image', proxyHandler)
      server.middlewares.use('/api/delete-telegram-media', telegramMediaDeletionDisabled)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const performanceMode = mode === 'performance'
  const loadedEnv = loadEnv(mode, process.cwd(), '')
  const explicitEnv = performanceMode ? readPerformanceEnvironment() : null
  const productionEnvironments = performanceMode
    ? readProductionTelegramEnvironments()
    : []
  const env = performanceMode
    ? resolvePerformanceEnvironment({
        env: loadedEnv,
        explicitEnv,
        productionEnvironments,
      })
    : loadedEnv
  const apiTarget = performanceMode
    ? PERFORMANCE_API_TARGET
    : 'http://127.0.0.1:3000'

  if (performanceMode) {
    const safetyConfig = validatePerformanceConfiguration({
      mode,
      env,
      explicitEnv,
      productionEnvironments,
    })

    await Promise.all([
      verifyTelegramTestResources(safetyConfig),
      verifyFirestoreEmulator({
        projectId: env.FIREBASE_PROJECT_ID,
        emulatorHost: env.FIRESTORE_EMULATOR_HOST,
      }),
    ])

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('VITE_') &&
          !Object.prototype.hasOwnProperty.call(explicitEnv, key)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, explicitEnv)
    process.env.APP_MODE = 'performance'
    assertServerPerformanceConfiguration(process.env)
  }

  const tunnelHost = String(env.VITE_NGROK_HOST || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')

  return {
    envDir: performanceMode ? false : undefined,
    optimizeDeps: {
      include: ['fflate'],
    },
    plugins: [
      react(),
      localTelegramUploadApi({
        telegramToken: env.TELEGRAM_BOT_TOKEN,
        telegramChannelId: env.TELEGRAM_CHANNEL_ID,
        performanceMode,
        apiTarget,
      }),
    ],
    // Temporary tunnel access for remote testing via ngrok.
    server: {
      proxy: createApiProxyConfig(apiTarget),
      host: true,
      allowedHosts: [
        'localhost',
        '127.0.0.1',
        '.ngrok-free.app',
        '.ngrok.io',
        ...(tunnelHost ? [tunnelHost] : []),
      ],
    },
  }
})
