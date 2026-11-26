import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import process from 'node:process'
import {
  PERFORMANCE_API_RUNTIME_ENV,
  PERFORMANCE_API_RUNTIME_HEADER,
  PERFORMANCE_API_RUNTIME_IDS,
  PERFORMANCE_API_STARTUP_HEADER,
  PERFORMANCE_AUTH_HOST,
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
  assertServerPerformanceConfiguration,
  sanitizePerformanceDiagnostic,
  verifyFirestoreEmulator,
} from '../server/performanceSafety.js'

export const PERFORMANCE_API_HOST = '127.0.0.1'
export const PERFORMANCE_API_PORT = 3001
export const PERFORMANCE_API_ROUTES = Object.freeze([
  '/api/best-sellers',
  '/api/test',
])

async function loadPerformanceApiHandlers() {
  const [bestSellers, health] = await Promise.all([
    import('../api/best-sellers.js'),
    import('../api/test.js'),
  ])
  return new Map([
    ['/api/best-sellers', bestSellers.default],
    ['/api/test', health.default],
  ])
}

function createResponseAdapter(response) {
  const adapter = {
    status(statusCode) {
      response.statusCode = statusCode
      return adapter
    },
    setHeader(name, value) {
      response.setHeader(name, value)
      return adapter
    },
    getHeader(name) {
      return response.getHeader(name)
    },
    end(body) {
      response.end(body)
      return adapter
    },
    json(body) {
      if (!response.hasHeader('Content-Type')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      response.end(JSON.stringify(body))
      return adapter
    },
    send(body) {
      response.end(body)
      return adapter
    },
  }
  return adapter
}

function createRequestHandler({ handlers, startupMs, getServer }) {
  return async function handleRequest(request, response) {
    const server = getServer()
    const port = server.address()?.port
    if (request.headers.host !== `${PERFORMANCE_API_HOST}:${port}`) {
      response.statusCode = 421
      response.end('Misdirected Request')
      return
    }

    const handler = handlers.get(request.url)
    if (!handler) {
      response.statusCode = 404
      response.end('Not Found')
      return
    }
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('Allow', 'GET')
      response.end('Method Not Allowed')
      return
    }
    if (request.headers['transfer-encoding'] ||
        Number(request.headers['content-length'] || 0) > 0) {
      response.statusCode = 400
      response.end('GET request bodies are not accepted')
      return
    }

    response.setHeader(
      PERFORMANCE_API_RUNTIME_HEADER,
      PERFORMANCE_API_RUNTIME_IDS.persistent,
    )
    response.setHeader(PERFORMANCE_API_STARTUP_HEADER, startupMs.toFixed(3))

    try {
      await handler(request, createResponseAdapter(response))
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({
          success: false,
          message: 'Unable to process the local performance API request.',
        }))
      } else {
        response.destroy()
      }
    }
  }
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      if (error?.code === 'EADDRINUSE') {
        rejectListen(new Error(
          `Persistent performance API cannot bind to ${PERFORMANCE_API_HOST}:${port}; the port is occupied. Stop its owner manually and retry.`,
        ))
        return
      }
      rejectListen(new Error('Persistent performance API failed to bind its loopback listener.'))
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, PERFORMANCE_API_HOST)
  })
}

export async function startPersistentPerformanceApi({
  env = process.env,
  root = process.cwd(),
  port = PERFORMANCE_API_PORT,
  assertConfiguration = assertServerPerformanceConfiguration,
  verifyEmulator = verifyFirestoreEmulator,
  loadHandlers = loadPerformanceApiHandlers,
  createHttpServer = createServer,
} = {}) {
  if (env[PERFORMANCE_API_RUNTIME_ENV] !== PERFORMANCE_API_RUNTIME_IDS.persistent) {
    throw new Error('Persistent API runtime was not explicitly selected.')
  }

  assertConfiguration(env, root)
  if (env.FIREBASE_PROJECT_ID !== PERFORMANCE_PROJECT_ID ||
      env.FIRESTORE_EMULATOR_HOST !== PERFORMANCE_FIRESTORE_HOST ||
      env.FIREBASE_AUTH_EMULATOR_HOST !== PERFORMANCE_AUTH_HOST) {
    throw new Error('Persistent API requires the demo Firebase project and configured local emulators.')
  }
  await verifyEmulator({
    projectId: env.FIREBASE_PROJECT_ID,
    emulatorHost: env.FIRESTORE_EMULATOR_HOST,
  })

  const handlers = await loadHandlers()
  for (const route of PERFORMANCE_API_ROUTES) {
    if (typeof handlers.get(route) !== 'function') {
      throw new Error('Persistent API handler registration is incomplete.')
    }
  }

  const startupMs = process.uptime() * 1000
  let server
  const requestHandler = createRequestHandler({
    handlers,
    startupMs,
    getServer: () => server,
  })
  server = createHttpServer(requestHandler)

  const address = await listen(server, port)
  const listeningPort = address.port
  let closePromise
  return {
    host: PERFORMANCE_API_HOST,
    port: listeningPort,
    startupMs,
    close() {
      if (closePromise) return closePromise
      closePromise = new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(new Error('Persistent performance API could not shut down cleanly.'))
            return
          }
          resolveClose()
        })
        server.closeIdleConnections?.()
      })
      return closePromise
    },
  }
}

async function main() {
  const runtime = await startPersistentPerformanceApi()
  console.info(
    `Persistent performance API ready at http://${runtime.host}:${runtime.port} ` +
    `(startup/import ${runtime.startupMs.toFixed(1)} ms).`,
  )

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void runtime.close().then(() => {
      console.info('Persistent performance API stopped after draining requests.')
    }).catch(() => {
      console.error('Persistent performance API shutdown failed.')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(
      `Persistent performance API startup failed: ${
        sanitizePerformanceDiagnostic(error?.message || error, 300)
      }`,
    )
    process.exitCode = 1
  })
}
