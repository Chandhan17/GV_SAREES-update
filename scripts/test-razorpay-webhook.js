import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REQUEST_TIMEOUT_MS = 5_000
const argumentsSet = new Set(process.argv.slice(2))
const invalidSignature = argumentsSet.has('--invalid-signature')

function loadWebhookSecret() {
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('Use Node.js 20.12 or newer to load local environment files.')
  }

  for (const relativePath of ['../.env.local', '../.env']) {
    const envPath = fileURLToPath(new URL(relativePath, import.meta.url))
    if (existsSync(envPath)) process.loadEnvFile(envPath)
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is missing or too short; no request was sent.')
  }
  return secret
}

function getSafeResponseBody(text, secret) {
  try {
    const response = JSON.parse(text)
    const safeResponse = {}
    if (typeof response.success === 'boolean') safeResponse.success = response.success
    if (typeof response.message === 'string') {
      safeResponse.message = response.message.split(secret).join('[REDACTED]')
    }
    if (typeof response.duplicate === 'boolean') safeResponse.duplicate = response.duplicate
    if (typeof response.outcome === 'string') safeResponse.outcome = response.outcome
    return JSON.stringify(safeResponse)
  } catch {
    return JSON.stringify({ message: 'Non-JSON response omitted.' })
  }
}

async function loadWebhookHandler() {
  const originalLog = console.log
  const originalInfo = console.info
  console.log = () => {}
  console.info = () => {}
  try {
    return (await import('../api/razorpay/webhook.js')).default
  } finally {
    console.log = originalLog
    console.info = originalInfo
  }
}

function createResponseAdapter(response) {
  return {
    setHeader: response.setHeader.bind(response),
    get statusCode() {
      return response.statusCode
    },
    set statusCode(statusCode) {
      response.statusCode = statusCode
    },
    status(statusCode) {
      response.statusCode = statusCode
      return this
    },
    json(body) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
      return this
    },
    end(body) {
      response.end(body)
      return this
    },
  }
}

async function createIsolatedWebhookServer(secret, webhookHandler) {
  const server = createServer((request, response) => {
    const processEvent = async () => ({
      duplicate: false,
      outcome: 'synthetic_event_accepted',
    })
    Promise.resolve(webhookHandler(request, createResponseAdapter(response), {
      webhookSecret: secret,
      processEvent,
      getTestConfiguration: () => ({}),
      rateLimit: () => true,
    })).catch(() => {
      if (response.headersSent) return
      response.statusCode = 500
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ success: false, message: 'Test harness request failed.' }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

async function main() {
  for (const argument of argumentsSet) {
    if (argument !== '--invalid-signature') {
      throw new Error(`Unknown option: ${argument}`)
    }
  }

  const secret = loadWebhookSecret()
  const randomId = randomBytes(16).toString('hex')
  const eventId = `evt_synthetic_${randomUUID()}`
  const eventPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_synthetic${randomId}`,
          order_id: `order_synthetic${randomId}`,
          status: 'captured',
          amount: 100,
          currency: 'INR',
        },
      },
    },
  }
  const rawBody = JSON.stringify(eventPayload)
  const validSignature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const signature = invalidSignature
    ? `${validSignature[0] === '0' ? '1' : '0'}${validSignature.slice(1)}`
    : validSignature

  const webhookHandler = await loadWebhookHandler()
  const server = await createIsolatedWebhookServer(secret, webhookHandler)
  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/razorpay/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': signature,
        'X-Razorpay-Event-Id': eventId,
      },
      body: Buffer.from(rawBody, 'utf8'),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const responseText = await response.text()
    process.stdout.write(`HTTP ${response.status}\n${getSafeResponseBody(responseText, secret)}\n`)
    const expectedStatus = invalidSignature ? 403 : 200
    if (response.status !== expectedStatus) process.exitCode = 1
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || 'Webhook test failed.'}\n`)
  process.exitCode = 1
})
