import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'

export const PERFORMANCE_API_LISTEN = '127.0.0.1:3001'
export const PERFORMANCE_FRONTEND_PORT = '5174'

export function resolveVercelCliEntry({
  platform = process.platform,
  appData = process.env.APPDATA,
  npmPrefix = process.env.npm_config_prefix,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const defaultPrefix = platform === 'win32'
    ? appData
      ? resolve(appData, 'npm')
      : resolve(home, 'AppData', 'Roaming', 'npm')
    : undefined
  const prefixes = [...new Set([npmPrefix, defaultPrefix].filter(Boolean))]
  const candidates = prefixes.map((prefix) => (
    resolve(prefix, 'node_modules', 'vercel', 'dist', 'vc.js')
  ))
  const entry = candidates.find(exists)

  if (!entry) {
    throw new Error('The Vercel CLI JavaScript entry point could not be located.')
  }
  return entry
}

export function createVercelDevCommand({
  platform = process.platform,
  root = process.cwd(),
  nodeExecutable = process.execPath,
  vercelCliEntry,
} = {}) {
  const args = [
    'dev',
    '--local-config',
    resolve(root, 'vercel.performance.json'),
    '--listen',
    PERFORMANCE_API_LISTEN,
  ]

  if (platform === 'win32') {
    if (!vercelCliEntry) {
      throw new Error('A Vercel CLI entry point is required on Windows.')
    }
    return { command: nodeExecutable, args: [vercelCliEntry, ...args] }
  }

  return { command: 'vercel', args }
}

export function parsePerformanceApiRuntime(argv = []) {
  let runtime = 'vercel'
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--api-runtime') {
      throw new Error(`Unknown performance launcher option: ${argv[index]}`)
    }
    runtime = argv[index + 1]
    index += 1
  }
  if (!['vercel', 'persistent'].includes(runtime)) {
    throw new Error('Performance API runtime must be vercel or persistent.')
  }
  return runtime
}

export function createPersistentApiDevCommand({
  root = process.cwd(),
  nodeExecutable = process.execPath,
} = {}) {
  return {
    command: nodeExecutable,
    args: [resolve(root, 'scripts', 'performanceApiServer.mjs')],
  }
}

export function createPerformanceApiDevCommand({
  apiRuntime,
  platform = process.platform,
  root = process.cwd(),
  nodeExecutable = process.execPath,
  vercelCliEntry,
} = {}) {
  if (apiRuntime === 'persistent') {
    return createPersistentApiDevCommand({ root, nodeExecutable })
  }
  if (apiRuntime === 'vercel') {
    return createVercelDevCommand({
      platform,
      root,
      nodeExecutable,
      vercelCliEntry,
    })
  }
  throw new Error('Performance API runtime must be vercel or persistent.')
}

export function createViteDevCommand({
  root = process.cwd(),
  nodeExecutable = process.execPath,
} = {}) {
  return {
    command: nodeExecutable,
    args: [
      resolve(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--mode',
      'performance',
      '--host',
      '127.0.0.1',
      '--port',
      PERFORMANCE_FRONTEND_PORT,
      '--strictPort',
    ],
  }
}

export function spawnPerformanceService(spawnImpl, command, args, { cwd, env }) {
  return spawnImpl(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  })
}

export async function waitForServiceReadiness({
  label = 'Service',
  verify,
  isRunning,
  timeoutMs = 30_000,
  retryIntervalMs = 500,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  const deadline = now() + timeoutMs
  let lastError

  while (now() < deadline && isRunning()) {
    try {
      await verify()
      return
    } catch (error) {
      lastError = error
    }

    const remaining = deadline - now()
    if (remaining > 0 && isRunning()) {
      await sleep(Math.min(retryIntervalMs, remaining))
    }
  }

  if (lastError) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      `${label} did not become ready within ${timeoutMs}ms. Last check: ${detail}`,
      { cause: lastError },
    )
  }

  throw new Error(`${label} exited before readiness could be verified.`)
}

export function stopChildIfRunning(child) {
  if (!child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.killed ||
      !child.pid) {
    return false
  }

  try {
    return child.kill()
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export function stopChildren(children) {
  const errors = []
  for (const child of children) {
    try {
      stopChildIfRunning(child)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}
