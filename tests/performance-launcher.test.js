import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { createApiProxyConfig } from '../server/apiProxyConfig.js'
import { createFirebaseAdminAppOptions } from '../server/firebaseAdminConfig.js'
import {
  PERFORMANCE_API_TARGET,
  PERFORMANCE_AUTH_HOST,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
} from '../server/performanceSafety.js'
import {
  createPerformanceApiDevCommand,
  createPersistentApiDevCommand,
  createVercelDevCommand,
  createViteDevCommand,
  parsePerformanceApiRuntime,
  PERFORMANCE_API_LISTEN,
  PERFORMANCE_FRONTEND_PORT,
  resolveVercelCliEntry,
  spawnPerformanceService,
  stopChildIfRunning,
  stopChildren,
  waitForServiceReadiness,
} from '../scripts/performanceLauncher.js'

test('performance launcher keeps Vercel as default and selects persistent API explicitly', () => {
  const root = String.raw`C:\Users\O'Neil\OneDrive\Desktop\Projects\GV Sarees`
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`
  assert.equal(parsePerformanceApiRuntime([]), 'vercel')
  assert.equal(parsePerformanceApiRuntime(['--api-runtime', 'persistent']), 'persistent')
  assert.throws(
    () => parsePerformanceApiRuntime(['--api-runtime', 'production']),
    /must be vercel or persistent/,
  )
  assert.throws(
    () => parsePerformanceApiRuntime(['--unknown']),
    /Unknown performance launcher option/,
  )
  assert.deepEqual(
    createPersistentApiDevCommand({ root, nodeExecutable }),
    {
      command: nodeExecutable,
      args: [resolve(root, 'scripts', 'performanceApiServer.mjs')],
    },
  )
})

test('persistent npm startup script selects the persistent API server', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const persistentScript = packageJson.scripts['dev:performance:persistent']
  const forwardedArguments = persistentScript.split(/\s+/).slice(2)
  const apiRuntime = parsePerformanceApiRuntime(forwardedArguments)
  const command = createPerformanceApiDevCommand({
    apiRuntime,
    root: String.raw`C:\GV Sarees`,
    nodeExecutable: String.raw`C:\Program Files\nodejs\node.exe`,
    platform: 'win32',
  })

  assert.equal(apiRuntime, 'persistent')
  assert.equal(command.command, String.raw`C:\Program Files\nodejs\node.exe`)
  assert.deepEqual(command.args, [
    resolve(String.raw`C:\GV Sarees`, 'scripts', 'performanceApiServer.mjs'),
  ])
})

test('default npm startup selects Vercel with local runtime identity markers', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const vercelScript = packageJson.scripts['dev:performance']
  const forwardedArguments = vercelScript.split(/\s+/).slice(2)
  const apiRuntime = parsePerformanceApiRuntime(forwardedArguments)
  const root = String.raw`C:\GV Sarees`
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`
  const vercelCliEntry = String.raw`C:\Users\O'Neil\AppData\Roaming\npm\node_modules\vercel\dist\vc.js`
  const command = createPerformanceApiDevCommand({
    apiRuntime,
    root,
    nodeExecutable,
    platform: 'win32',
    vercelCliEntry,
  })
  const vercelConfig = JSON.parse(readFileSync(
    new URL('../vercel.performance.json', import.meta.url),
    'utf8',
  ))

  assert.equal(apiRuntime, 'vercel')
  assert.equal(command.command, nodeExecutable)
  assert.deepEqual(command.args, [
    vercelCliEntry,
    'dev',
    '--local-config',
    resolve(root, 'vercel.performance.json'),
    '--listen',
    PERFORMANCE_API_LISTEN,
  ])
  assert.deepEqual(vercelConfig.env, {
    APP_MODE: 'performance',
    GV_PERFORMANCE_API_RUNTIME: 'vercel',
    VERCEL: '1',
    VERCEL_ENV: 'development',
  })
})

test('Windows launcher passes spaced and apostrophized paths as argv without a shell', () => {
  const appData = String.raw`C:\Users\O'Neil\AppData\Roaming`
  const root = String.raw`C:\Users\O'Neil\OneDrive\Desktop\Women's fashion\GV Sarees`
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`
  const expectedEntry = resolve(appData, 'npm', 'node_modules', 'vercel', 'dist', 'vc.js')
  const vercelCliEntry = resolveVercelCliEntry({
    platform: 'win32',
    appData,
    npmPrefix: '',
    exists: (candidate) => candidate === expectedEntry,
  })
  const command = createVercelDevCommand({
    platform: 'win32',
    root,
    nodeExecutable,
    vercelCliEntry,
  })
  let invocation
  const child = {}

  assert.equal(vercelCliEntry, expectedEntry)
  assert.equal(command.command, nodeExecutable)
  assert.equal(command.args[0], vercelCliEntry)
  assert.equal(command.args[3], resolve(root, 'vercel.performance.json'))
  assert.equal(command.args[5], PERFORMANCE_API_LISTEN)
  assert.equal(spawnPerformanceService(
    (spawnCommand, args, options) => {
      invocation = { spawnCommand, args, options }
      return child
    },
    command.command,
    command.args,
    { cwd: root, env: {} },
  ), child)
  assert.equal(invocation.spawnCommand, nodeExecutable)
  assert.equal(invocation.args[0], vercelCliEntry)
  assert.equal(invocation.options.cwd, root)
  assert.equal(invocation.options.shell, false)
})

test('performance services keep Vite on 5174 and API requests on 3001', () => {
  const root = String.raw`C:\Users\O'Neil\OneDrive\Desktop\Women's fashion\GV Sarees`
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`
  const viteCommand = createViteDevCommand({ root, nodeExecutable })
  const frontendPortIndex = viteCommand.args.indexOf('--port')
  const vercelConfig = JSON.parse(readFileSync(
    new URL('../vercel.performance.json', import.meta.url),
    'utf8',
  ))
  const proxyConfig = createApiProxyConfig(PERFORMANCE_API_TARGET)

  assert.equal(viteCommand.command, nodeExecutable)
  assert.equal(viteCommand.args[frontendPortIndex + 1], PERFORMANCE_FRONTEND_PORT)
  assert.equal(viteCommand.args.includes('--strictPort'), true)
  assert.equal(PERFORMANCE_API_LISTEN, '127.0.0.1:3001')
  assert.equal(PERFORMANCE_API_TARGET, 'http://127.0.0.1:3001')
  assert.equal(proxyConfig['/api/test'].target, 'http://127.0.0.1:3001')
  assert.equal(Object.values(proxyConfig).every((proxy) => (
    proxy.target === 'http://127.0.0.1:3001' && proxy.changeOrigin
  )), true)
  assert.equal(vercelConfig.framework, null)
  assert.equal(vercelConfig.devCommand, null)
  assert.equal(vercelConfig.env.VERCEL, '1')
  assert.equal(vercelConfig.env.VERCEL_ENV, 'development')
  assert.equal(vercelConfig.rewrites, undefined)
  assert.equal(vercelConfig.builds.length > 0, true)
  assert.equal(vercelConfig.builds.every((build) => build.src.startsWith('api/')), true)
})

test('performance Vercel config registers the health handler without exposing helpers', async () => {
  const vercelConfig = JSON.parse(readFileSync(
    new URL('../vercel.performance.json', import.meta.url),
    'utf8',
  ))
  const healthRoute = vercelConfig.routes.find((route) => route.src === '^/api/(?!_lib/)(.+)$')
  const imageRoute = vercelConfig.routes.find((route) => route.src === '^/api/image/(.*)$')
  const healthHandler = await import('../api/test.js')

  assert.ok(healthRoute)
  assert.ok(imageRoute)
  const healthPathMatch = '/api/test'.match(new RegExp(healthRoute.src))
  const helperPathMatch = '/api/_lib/telegramUpload.js'.match(new RegExp(healthRoute.src))
  assert.deepEqual(healthPathMatch && healthRoute.dest.replace('$1', healthPathMatch[1]), '/api/test.js')
  assert.equal(helperPathMatch, null)
  assert.equal(imageRoute.dest, '/api/image/[...path].js?path=$1')
  assert.equal(vercelConfig.builds.some((build) => build.src === 'api/*.js'), true)
  assert.equal(vercelConfig.builds.some((build) => build.src.includes('_lib')), false)
  assert.equal(typeof healthHandler.default, 'function')
})

test('performance Firebase Admin options use only the demo project and emulator hosts', () => {
  const env = {
    FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
    FIRESTORE_EMULATOR_HOST: PERFORMANCE_FIRESTORE_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: PERFORMANCE_AUTH_HOST,
  }
  const options = createFirebaseAdminAppOptions({
    performanceMode: true,
    env,
    credential: { getAccessToken: async () => ({ access_token: 'unused' }) },
  })

  assert.deepEqual(options, { projectId: PERFORMANCE_PROJECT_ID })
  assert.equal(Object.prototype.hasOwnProperty.call(options, 'credential'), false)

  for (const key of Object.keys(env)) {
    assert.throws(
      () => createFirebaseAdminAppOptions({
        performanceMode: true,
        env: { ...env, [key]: 'not-the-configured-emulator' },
      }),
      /not emulator-only/,
    )
  }

  const productionCredential = {}
  assert.equal(
    createFirebaseAdminAppOptions({
      performanceMode: false,
      credential: productionCredential,
    }).credential,
    productionCredential,
  )
})

test('Firebase Admin Firestore initializes for the emulator without a service account', async () => {
  const { deleteApp, initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const previousHost = process.env.FIRESTORE_EMULATOR_HOST
  process.env.FIRESTORE_EMULATOR_HOST = PERFORMANCE_FIRESTORE_HOST
  let app

  try {
    app = initializeApp(createFirebaseAdminAppOptions({
      performanceMode: true,
      env: {
        FIREBASE_PROJECT_ID: PERFORMANCE_PROJECT_ID,
        FIRESTORE_EMULATOR_HOST: PERFORMANCE_FIRESTORE_HOST,
        FIREBASE_AUTH_EMULATOR_HOST: PERFORMANCE_AUTH_HOST,
      },
    }), 'performance-emulator-no-credentials-test')
    assert.doesNotThrow(() => getFirestore(app))
  } finally {
    if (app) await deleteApp(app)
    if (previousHost === undefined) {
      delete process.env.FIRESTORE_EMULATOR_HOST
    } else {
      process.env.FIRESTORE_EMULATOR_HOST = previousHost
    }
  }
})

test('launcher cleanup skips exited children and tolerates a vanished process', () => {
  let exitedKillCalls = 0
  const exited = {
    exitCode: 0,
    signalCode: null,
    killed: false,
    pid: 123,
    kill() {
      exitedKillCalls += 1
      return true
    },
  }
  const vanished = {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 456,
    kill() {
      const error = new Error('process already exited')
      error.code = 'ESRCH'
      throw error
    },
  }

  assert.equal(stopChildIfRunning(exited), false)
  assert.equal(exitedKillCalls, 0)
  assert.equal(stopChildIfRunning(vanished), false)
})

test('launcher cleanup continues stopping siblings after an individual kill error', () => {
  let runningKillCalls = 0
  const failingChild = {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 789,
    kill() {
      throw new Error('unexpected termination failure')
    },
  }
  const runningChild = {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 790,
    kill() {
      runningKillCalls += 1
      return true
    },
  }

  const errors = stopChildren([failingChild, runningChild])
  assert.equal(errors.length, 1)
  assert.equal(runningKillCalls, 1)
})

test('backend readiness timeout retains the last diagnostic instead of hiding it', async () => {
  let now = 0
  let attempts = 0
  const lastFailure = new Error('Performance API backend returned HTTP 404 Not Found.')

  await assert.rejects(
    waitForServiceReadiness({
      label: 'API backend',
      verify: async () => {
        attempts += 1
        throw lastFailure
      },
      isRunning: () => true,
      timeoutMs: 10,
      retryIntervalMs: 5,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    }),
    (error) => {
      assert.match(error.message, /API backend did not become ready within 10ms/)
      assert.match(error.message, /HTTP 404 Not Found/)
      assert.equal(error.cause, lastFailure)
      return true
    },
  )
  assert.equal(attempts, 2)
})
