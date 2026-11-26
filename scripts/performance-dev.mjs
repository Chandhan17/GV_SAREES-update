import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import {
  PERFORMANCE_PROJECT_ID,
  PERFORMANCE_API_RUNTIME_ENV,
  PERFORMANCE_API_RUNTIME_IDS,
  assertServerPerformanceConfiguration,
  readEnvFile,
  readPerformanceEnvironment,
  readProductionTelegramEnvironments,
  sanitizePerformanceDiagnostic,
  validatePerformanceConfiguration,
  verifyFirestoreEmulator,
  verifyPerformanceApiBackend,
  verifyTelegramTestResources,
} from '../server/performanceSafety.js'
import {
  createPerformanceApiDevCommand,
  createViteDevCommand,
  parsePerformanceApiRuntime,
  resolveVercelCliEntry,
  spawnPerformanceService,
  stopChildren as stopPerformanceChildren,
  waitForServiceReadiness,
} from './performanceLauncher.js'

const root = process.cwd()
const apiRuntime = parsePerformanceApiRuntime(process.argv.slice(2))
const explicitEnv = readPerformanceEnvironment(root)
const productionEnvironments = readProductionTelegramEnvironments(root)
const env = {
  ...readEnvFile(resolve(root, '.env')),
  ...readEnvFile(resolve(root, '.env.local')),
  ...explicitEnv,
}
const config = validatePerformanceConfiguration({
  mode: 'performance',
  env,
  explicitEnv,
  productionEnvironments,
})

await verifyTelegramTestResources(config)
await verifyFirestoreEmulator({
  projectId: config.projectId,
  emulatorHost: config.firestoreHost,
})

const childEnv = {
  ...process.env,
  ...explicitEnv,
  APP_MODE: 'performance',
  FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: config.firestoreHost,
  FIREBASE_AUTH_EMULATOR_HOST: config.authHost,
  [PERFORMANCE_API_RUNTIME_ENV]: PERFORMANCE_API_RUNTIME_IDS[apiRuntime],
}
delete childEnv.PORT
assertServerPerformanceConfiguration(childEnv, root)

const children = []
let stopping = false

function stopChildren() {
  if (stopping) return
  stopping = true
  const errors = stopPerformanceChildren(children)
  if (errors.length) {
    console.error('One or more performance services could not be stopped cleanly.')
  }
}

process.on('SIGINT', stopChildren)
process.on('SIGTERM', stopChildren)

function start(command, args, env = childEnv) {
  const child = spawnPerformanceService(spawn, command, args, { cwd: root, env })
  children.push(child)
  child.once('error', (error) => {
    if (error?.code === 'ESRCH') return
    console.error('Unable to start a required performance-mode service.')
    stopChildren()
  })
  child.once('exit', (code) => {
    if (!stopping) {
      stopping = true
      const errors = stopPerformanceChildren(children.filter((sibling) => sibling !== child))
      if (errors.length) {
        console.error('One or more performance services could not be stopped cleanly.')
      }
      process.exitCode = code || 0
    }
  })
  return child
}

const apiCommand = createPerformanceApiDevCommand({
  apiRuntime,
  platform: process.platform,
  root,
  nodeExecutable: process.execPath,
  vercelCliEntry: process.platform === 'win32' &&
    apiRuntime === PERFORMANCE_API_RUNTIME_IDS.vercel
    ? resolveVercelCliEntry()
    : undefined,
})
const backend = start(apiCommand.command, apiCommand.args)

async function waitForBackend() {
  await waitForServiceReadiness({
    label: 'The isolated performance API backend',
    verify: () => verifyPerformanceApiBackend({ expectedRuntime: apiRuntime }),
    isRunning: () => backend.exitCode === null,
  })
}

async function waitForFrontend(frontend) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && frontend.exitCode === null) {
    try {
      const response = await fetch('http://127.0.0.1:5174', {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) return
    } catch {
      // The frontend may still be binding its configured port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('The performance frontend did not become ready on port 5174.')
}

try {
  await waitForBackend()
  const viteCommand = createViteDevCommand({ root, nodeExecutable: process.execPath })
  const frontend = start(viteCommand.command, viteCommand.args, {
    ...childEnv,
    PORT: '5174',
  })
  await waitForFrontend(frontend)
  console.info(
    `Performance test services are isolated using the ${apiRuntime} API runtime; ` +
    'no benchmark has been started.',
  )
} catch (error) {
  const diagnostic = sanitizePerformanceDiagnostic(error?.message || error)
  console.error(`Performance startup failed: ${diagnostic}`)
  console.error('Performance services were not started.')
  stopChildren()
  process.exitCode = 1
}
