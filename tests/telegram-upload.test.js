import assert from 'node:assert/strict'
import { Buffer, File } from 'node:buffer'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { createServer } from 'vite'
import sharp from 'sharp'

function makeMultipart({ boundary, filename = 'saree.png', contentType = 'image/png', data, close = true }) {
  const ending = close ? `\r\n--${boundary}--\r\n` : ''
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(ending),
  ])
}

async function sendToHandler(handler, body, boundary, contentType = `multipart/form-data; boundary=${boundary}`) {
  const server = createHttpServer((req, res) => {
    handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(error.message)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/upload-image',
        method: 'POST',
        headers: {
          'content-type': contentType,
          'content-length': body.length,
        },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.on('error', reject)
      request.end(body)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function sendWithRestoredVercelStream(handler, body, boundary) {
  const replay = new PassThrough()
  replay.end(body)

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/upload-image'
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  }
  req.readable = false
  req.readableEnded = true
  req.destroyed = true
  Object.defineProperty(req, 'body', {
    get() {
      return undefined
    },
  })

  const originalOn = req.on.bind(req)
  req.on = (event, listener) => (
    event === 'data' || event === 'end'
      ? replay.on(event, listener)
      : originalOn(event, listener)
  )

  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(value = '') {
      this.body = String(value)
    },
  }

  await handler(req, res)
  return { statusCode: res.statusCode, body: res.body }
}

async function sendWithBufferedRawBody(handler, body, boundary) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/upload-image'
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  }
  req.rawBody = body
  req.readable = false
  req.readableEnded = true
  req.destroyed = true
  req.on = () => {
    throw new Error('The ended request stream must not be read when rawBody is available.')
  }

  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(value = '') {
      this.body = String(value)
    },
  }

  await handler(req, res)
  return { statusCode: res.statusCode, body: res.body }
}

function validProduct(overrides = {}) {
  return {
    name: 'Red Banarasi Saree',
    price: 4999,
    category: 'Pattu',
    description: 'A traditional saree',
    fabric: 'Silk',
    images: [],
    sizeLength: '5.5 m',
    sizeChartText: '',
    totalStock: 10,
    lowStockThreshold: 2,
    ...overrides,
  }
}

test('Telegram upload flow handles browser uploads and mocked multipart requests', async (t) => {
  const mocks = {
    posts: [],
    uploadResponses: [],
    telegramCalls: [],
    productRequests: [],
    auth: { currentUser: { getIdToken: async () => 'mock-admin-token' } },
    db: {},
  }
  mocks.axios = {
    async post(url) {
      mocks.telegramCalls.push(url)
      if (mocks.telegramError) throw mocks.telegramError
      return {
        data: {
          result: {
            photo: [{ file_id: 'mock-telegram-file-id' }],
            message_id: 17,
            chat: { id: '-100123' },
          },
        },
      }
    },
    async get(url) {
      mocks.telegramCalls.push(url)
      return { data: { result: { file_path: 'photos/mock-image.webp' } } }
    },
    isAxiosError(error) {
      return Boolean(error?.isAxiosError)
    },
  }

  const previousFetch = globalThis.fetch
  const previousFormData = globalThis.FormData
  const nativeFormData = previousFormData
  const previousCreateImageBitmap = globalThis.createImageBitmap
  const previousDocument = globalThis.document
  const nativeFetch = previousFetch
  globalThis.__telegramUploadMocks = mocks
  const MockFormData = class MockFormData {
    constructor() {
      this.fields = []
    }

    append(...args) {
      this.fields.push(args)
    }

    entries() {
      return this.fields.map(([name, value]) => [name, value])[Symbol.iterator]()
    }
  }
  globalThis.FormData = MockFormData
  globalThis.fetch = async (url, options) => {
    if (url === '/api/upload-image') {
      mocks.posts.push({ url, options })
      if (mocks.forwardUpload) return mocks.forwardUpload(options.body, options)
      const result = mocks.uploadResponses.shift()
      if (result instanceof Error) throw result
      if (result?.httpStatus) {
        return { ok: false, status: result.httpStatus, json: async () => result.body || {} }
      }
      return { ok: true, status: 200, json: async () => result }
    }

    mocks.productRequests.push({ url, options })
    return { ok: true, json: async () => ({ success: true, productId: 'created-product' }) }
  }

  const server = await createServer({
    appType: 'custom',
    configFile: false,
    plugins: [{
      name: 'telegram-upload-test-mocks',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'axios') return '\0mock-telegram-upload-axios'
        if (source === './authService') return '\0mock-upload-auth'
        if (source === './firebase') return '\0mock-upload-firebase'
        if (source === 'firebase/firestore') return '\0mock-upload-firestore'
        return null
      },
      load(id) {
        if (id === '\0mock-telegram-upload-axios') {
          return 'export default globalThis.__telegramUploadMocks.axios'
        }
        if (id === '\0mock-upload-auth') {
          return 'export async function getIdToken() { return "mock-admin-token" }'
        }
        if (id === '\0mock-upload-firebase') {
          return 'const mocks = globalThis.__telegramUploadMocks; export const auth = mocks.auth; export const db = mocks.db;'
        }
        if (id === '\0mock-upload-firestore') {
          return 'export const collection = () => ({}); export const doc = () => ({}); export const getDoc = async () => ({ exists: () => false }); export const getDocs = async () => ({ docs: [] }); export const orderBy = () => ({}); export const query = () => ({});'
        }
        return null
      },
    }],
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ['axios', 'firebase'] },
  })

  try {
    const uploads = await server.ssrLoadModule('/src/services/telegramUploadService.js')
    const products = await server.ssrLoadModule('/src/services/productService.js')
    const telegram = await server.ssrLoadModule('/api/_lib/telegramUpload.js')
    const makeFile = (name, type = 'image/png', size = 1024) => ({
      name,
      type,
      size,
      lastModified: 1,
    })
    const uploadResult = (fileId) => ({
      file_id: fileId,
      file_path: `photos/${fileId}.webp`,
      telegram_message_id: 17,
      telegram_chat_id: '-100123',
    })

    await t.test('single upload sends one FormData file without setting multipart Content-Type', async () => {
      mocks.uploadResponses = [uploadResult('single-image')]
      mocks.posts.length = 0

      const result = await uploads.uploadSingleImage(makeFile('single.png'))

      assert.equal(result.file_id, 'single-image')
      assert.equal(mocks.posts.length, 1)
      assert.equal(mocks.posts[0].url, '/api/upload-image')
      assert.equal(mocks.posts[0].options.headers.Authorization, 'Bearer mock-admin-token')
      assert.equal(Object.keys(mocks.posts[0].options.headers).some((key) => key.toLowerCase() === 'content-type'), false)
      assert.equal(mocks.posts[0].options.body.fields.length, 1)
      assert.equal(mocks.posts[0].options.body.fields[0][0], 'image')
      assert.equal(mocks.posts[0].options.body.fields[0][2], 'single.png')
      assert.equal(mocks.posts[0].options.body.fields[0][1].name, 'single.png')
    })

    await t.test('JPEG uploads retain their MIME type and empty selections make no request', async () => {
      mocks.uploadResponses = [uploadResult('jpeg-image')]
      mocks.posts.length = 0

      await uploads.uploadSingleImage(makeFile('sample.jpeg', 'image/jpeg'))

      assert.equal(mocks.posts[0].options.body.fields[0][1].type, 'image/jpeg')
      assert.equal(mocks.posts[0].options.body.fields[0][2], 'sample.jpeg')

      mocks.posts.length = 0
      const empty = await uploads.uploadMultipleImages([])
      assert.deepEqual(empty.success, [])
      assert.equal(empty.failedCount, 0)
      assert.equal(mocks.posts.length, 0)
    })

    await t.test('zero-byte files are rejected before making a request', async () => {
      mocks.posts.length = 0

      await assert.rejects(
        uploads.uploadSingleImage(makeFile('empty.png', 'image/png', 0)),
        /Selected image is empty/,
      )
      assert.equal(mocks.posts.length, 0)
    })

    await t.test('large images are resized and compressed below the hosted request budget', async () => {
      globalThis.createImageBitmap = async () => ({
        width: 4000,
        height: 3000,
        close() {},
      })
      globalThis.document = {
        createElement() {
          return {
            getContext: () => ({ drawImage() {} }),
            toBlob(callback, type) {
              callback(new Blob([new Uint8Array(128)], { type }))
            },
          }
        },
      }
      mocks.uploadResponses = [uploadResult('compressed-image')]
      mocks.posts.length = 0

      await uploads.uploadSingleImage(makeFile('large-photo.jpg', 'image/jpeg', 5 * 1024 * 1024))

      const [field, compressedFile, filename] = mocks.posts[0].options.body.fields[0]
      assert.equal(field, 'image')
      assert.ok(compressedFile instanceof File)
      assert.equal(compressedFile.type, 'image/webp')
      assert.equal(compressedFile.name, 'large-photo.webp')
      assert.equal(filename, 'large-photo.webp')
      assert.ok(compressedFile.size <= 4 * 1024 * 1024)
    })

    await t.test('unsupported image types are rejected before making a request', async () => {
      mocks.posts.length = 0

      await assert.rejects(
        uploads.uploadSingleImage(makeFile('animated.gif', 'image/gif')),
        /Only JPEG, PNG or WEBP images are allowed/,
      )
      assert.equal(mocks.posts.length, 0)
    })

    await t.test('multiple uploads are individual requests and retain successes on partial failure', async () => {
      const firstFile = makeFile('first.png')
      const secondFile = makeFile('second.png')
      const uploadStatuses = []
      mocks.uploadResponses = [
        uploadResult('first-image'),
        { httpStatus: 400, body: { error: 'Malformed multipart upload.' } },
      ]
      mocks.posts.length = 0

      const result = await uploads.uploadMultipleImages([firstFile, secondFile], {
        onStatus: (file, status) => uploadStatuses.push([file.name, status]),
      })

      assert.equal(mocks.posts.length, 2)
      assert.ok(mocks.posts.every((request) => request.url === '/api/upload-image'))
      assert.ok(mocks.posts.every((request) => request.options.body.fields.length === 1))
      assert.equal(result.success.length, 1)
      assert.equal(result.success[0].file_id, 'first-image')
      assert.equal(result.failedCount, 1)
      assert.match(result.errors[0], /second\.png: Malformed multipart upload\./)
      assert.deepEqual(uploadStatuses.sort(), [
        ['first.png', 'uploaded'],
        ['first.png', 'uploading'],
        ['second.png', 'failed'],
        ['second.png', 'uploading'],
      ].sort())

      mocks.uploadResponses = [uploadResult('second-image')]
      const retry = await uploads.uploadMultipleImages([firstFile, secondFile])
      assert.equal(retry.failedCount, 0)
      assert.deepEqual(retry.success.map((image) => image.file_id), ['first-image', 'second-image'])
      assert.equal(mocks.posts.length, 3)
    })

    await t.test('native FormData creates a matching boundary and preserves the spaced filename', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const png = await sharp({
        create: { width: 3, height: 2, channels: 3, background: { r: 90, g: 140, b: 210 } },
      }).png().toBuffer()
      const filename = 'GV Sarees_ Thoughtfully Chosen Drapes.png'
      const file = new File([png], filename, { type: 'image/png' })
      const requestHeaders = []
      const localServer = createHttpServer((req, res) => {
        requestHeaders.push(req.headers)
        handler(req, res).catch((error) => {
          res.statusCode = 500
          res.end(error.message)
        })
      })
      await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve))
      const { port } = localServer.address()

      globalThis.FormData = nativeFormData
      mocks.posts.length = 0
      mocks.telegramCalls.length = 0
      mocks.forwardUpload = async (formData, options) => {
        assert.ok(formData instanceof nativeFormData)
        assert.equal(formData.getAll('image').length, 1)
        assert.ok(formData.getAll('image')[0] instanceof File)
        assert.ok([filename, 'second.png'].includes(formData.getAll('image')[0].name))
        assert.deepEqual(Buffer.from(await formData.getAll('image')[0].arrayBuffer()), png)
        assert.equal(Object.keys(options.headers).some((key) => key.toLowerCase() === 'content-type'), false)

        return nativeFetch(`http://127.0.0.1:${port}/api/upload-image`, options)
      }

      try {
        const secondFile = new File([png], 'second.png', { type: 'image/png' })
        const result = await uploads.uploadMultipleImages([file, secondFile])

        assert.equal(result.success.length, 2)
        assert.match(requestHeaders[0]['content-type'], /^multipart\/form-data;\s*boundary=.+/)
        assert.match(requestHeaders[1]['content-type'], /^multipart\/form-data;\s*boundary=.+/)
        if (requestHeaders[0]['content-length']) {
          assert.ok(Number(requestHeaders[0]['content-length']) > png.length)
        }
        assert.equal(mocks.telegramCalls.filter((url) => url.endsWith('/sendPhoto')).length, 2)
        assert.equal(mocks.telegramCalls.filter((url) => url.endsWith('/getFile')).length, 2)
      } finally {
        mocks.forwardUpload = null
        globalThis.FormData = MockFormData
        await new Promise((resolve) => localServer.close(resolve))
      }
    })

    await t.test('successful product creation uses uploaded image references', async () => {
      mocks.uploadResponses = [uploadResult('product-image')]
      mocks.posts.length = 0
      mocks.productRequests.length = 0

      const uploaded = await uploads.uploadMultipleImages([makeFile('product.png')])
      const productId = await products.createProduct(
        validProduct({ images: uploaded.success }),
        'create_image_key_123456',
      )

      assert.equal(productId, 'created-product')
      assert.equal(mocks.productRequests.length, 1)
      const request = JSON.parse(mocks.productRequests[0].options.body)
      assert.equal(request.images.length, 1)
      assert.equal(request.images[0].file_id, 'product-image')
    })

    await t.test('failed image uploads cannot submit a product with an empty image array', async () => {
      mocks.uploadResponses = [{ httpStatus: 500, body: { error: 'Upload failed.' } }]
      mocks.productRequests.length = 0

      const uploaded = await uploads.uploadMultipleImages([makeFile('failed.png')])
      assert.equal(uploaded.success.length, 0)
      await assert.rejects(
        products.createProduct(validProduct({ images: uploaded.success }), 'create_image_key_654321'),
        /At least one product image is required/,
      )
      assert.equal(mocks.productRequests.length, 0)
    })

    await t.test('Telegram handler accepts a valid mocked multipart upload', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: { r: 210, g: 40, b: 80 } },
      }).png().toBuffer()
      const boundary = 'mock-valid-boundary'
      mocks.telegramCalls.length = 0
      const response = await sendToHandler(
        handler,
        makeMultipart({ boundary, data: png }),
        boundary,
      )

      assert.equal(response.statusCode, 200)
      assert.equal(JSON.parse(response.body).file_id, 'mock-telegram-file-id')
      assert.deepEqual(mocks.telegramCalls, [
        'https://api.telegram.org/botmock-token/sendPhoto',
        'https://api.telegram.org/botmock-token/getFile',
      ])
    })

    await t.test('Telegram upload destination comes only from server configuration', async () => {
      let destination
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
        uploadImage: async ({ telegramChannelId }) => {
          destination = telegramChannelId
          return { file_id: 'configured-destination-image' }
        },
      })
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: { r: 210, g: 40, b: 80 } },
      }).png().toBuffer()
      const boundary = 'configured-channel-boundary'
      const response = await sendToHandler(
        handler,
        makeMultipart({ boundary, data: png }),
        boundary,
      )

      assert.equal(response.statusCode, 200)
      assert.equal(destination, '-100123')
    })

    await t.test('consumed Vercel Dev requests are replayed from original multipart bytes', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
        uploadImage: async ({ buffer }) => ({
          file_id: 'mock-replayed-image',
          receivedBytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        }),
      })
      const png = await sharp({
        create: { width: 3, height: 2, channels: 3, background: { r: 35, g: 100, b: 210 } },
      }).png().toBuffer()
      const boundary = 'vercel-dev-replayed-boundary'
      const response = await sendWithRestoredVercelStream(
        handler,
        makeMultipart({ boundary, filename: 'stream-probe.png', data: png }),
        boundary,
      )

      assert.equal(response.statusCode, 200)
      assert.deepEqual(JSON.parse(response.body), {
        file_id: 'mock-replayed-image',
        receivedBytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      })
    })

    await t.test('an exposed rawBody Buffer is parsed without reading the ended request stream', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
        uploadImage: async ({ buffer }) => ({
          file_id: 'mock-buffered-image',
          receivedBytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        }),
      })
      const png = await sharp({
        create: { width: 2, height: 3, channels: 3, background: { r: 80, g: 170, b: 45 } },
      }).png().toBuffer()
      const boundary = 'buffered-raw-body-boundary'
      const response = await sendWithBufferedRawBody(
        handler,
        makeMultipart({ boundary, filename: 'buffered.png', data: png }),
        boundary,
      )

      assert.equal(response.statusCode, 200)
      assert.deepEqual(JSON.parse(response.body), {
        file_id: 'mock-buffered-image',
        receivedBytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      })
    })

    await t.test('oversized multipart files return HTTP 413', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const boundary = 'mock-oversized-boundary'
      const response = await sendToHandler(handler, makeMultipart({
        boundary,
        data: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
      }), boundary)

      assert.equal(response.statusCode, 413)
      assert.equal(JSON.parse(response.body).error, 'Image must be 5MB or smaller.')
    })

    await t.test('unsupported multipart image types return HTTP 400', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const boundary = 'mock-invalid-type-boundary'
      const response = await sendToHandler(handler, makeMultipart({
        boundary,
        filename: 'animated.gif',
        contentType: 'image/gif',
        data: Buffer.from('not an image'),
      }), boundary)

      assert.equal(response.statusCode, 400)
      assert.equal(JSON.parse(response.body).error, 'Only JPEG, PNG or WEBP images are allowed.')
    })

    await t.test('malformed multipart requests return HTTP 400 without Telegram calls', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const boundary = 'mock-malformed-boundary'
      mocks.telegramCalls.length = 0
      const response = await sendToHandler(handler, makeMultipart({
        boundary,
        data: Buffer.from('partial file data'),
        close: false,
      }), boundary)

      assert.equal(response.statusCode, 400)
      assert.equal(JSON.parse(response.body).error, 'Malformed multipart upload.')
      assert.deepEqual(mocks.telegramCalls, [])
    })

    await t.test('multipart requests without a boundary are rejected before parsing', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const response = await sendToHandler(
        handler,
        Buffer.from('not multipart'),
        'unused',
        'multipart/form-data',
      )

      assert.equal(response.statusCode, 400)
      assert.match(JSON.parse(response.body).error, /Multipart boundary is missing/)
      assert.deepEqual(mocks.telegramCalls, [])
    })

    await t.test('empty multipart image files return a useful client error', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const boundary = 'mock-empty-boundary'
      const response = await sendToHandler(handler, makeMultipart({
        boundary,
        data: Buffer.alloc(0),
      }), boundary)

      assert.equal(response.statusCode, 400)
      assert.equal(JSON.parse(response.body).error, 'Image file is empty.')
      assert.deepEqual(mocks.telegramCalls, [])
    })

    await t.test('invalid image bytes return HTTP 400', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const boundary = 'mock-invalid-bytes-boundary'
      const response = await sendToHandler(handler, makeMultipart({
        boundary,
        contentType: 'image/png',
        data: Buffer.from('not a PNG'),
      }), boundary)

      assert.equal(response.statusCode, 400)
      assert.equal(JSON.parse(response.body).error, 'Uploaded file is not a valid image.')
    })

    await t.test('Telegram storage failures return a gateway error', async () => {
      const handler = telegram.createTelegramImageHandler({
        telegramToken: 'mock-token',
        telegramChannelId: '-100123',
      })
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: { r: 210, g: 40, b: 80 } },
      }).png().toBuffer()
      const boundary = 'mock-telegram-failure-boundary'
      mocks.telegramError = Object.assign(new Error('Telegram is unavailable.'), {
        isAxiosError: true,
        response: { status: 503, data: { description: 'Telegram is unavailable.' } },
      })
      const response = await sendToHandler(handler, makeMultipart({ boundary, data: png }), boundary)
      mocks.telegramError = null

      assert.equal(response.statusCode, 502)
      assert.equal(JSON.parse(response.body).error, 'Telegram is unavailable.')
    })

    await t.test('Vercel upload route disables body parsing before admin auth and Multer', () => {
      const route = readFileSync(new URL('../api/upload-image.js', import.meta.url), 'utf8')
      const adminAuth = readFileSync(new URL('../server/verifyAdmin.js', import.meta.url), 'utf8')
      assert.match(route, /api:\s*\{\s*bodyParser:\s*false/s)
      assert.doesNotMatch(adminAuth, /req\.body/)
    })

    await t.test("request diagnostics inspect headers without evaluating Vercel's lazy body getter", () => {
      const previousNodeEnv = process.env.NODE_ENV
      const previousInfo = console.info
      const diagnosticLogs = []
      let bodyGetterCalled = false
      const req = {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=diagnostic-boundary',
          'content-length': '123',
        },
        readable: true,
        readableEnded: false,
        destroyed: false,
        get body() {
          bodyGetterCalled = true
          throw new Error('Lazy body getter must not run before Multer.')
        },
      }

      process.env.NODE_ENV = 'development'
      console.info = (...args) => diagnosticLogs.push(args)
      try {
        telegram.logUploadRequestDiagnostics(req, 'test')
      } finally {
        console.info = previousInfo
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV
        } else {
          process.env.NODE_ENV = previousNodeEnv
        }
      }

      assert.equal(bodyGetterCalled, false)
      assert.equal(diagnosticLogs.length, 1)
      assert.equal(diagnosticLogs[0][1].boundaryPresent, true)
      assert.equal(diagnosticLogs[0][1].contentLength, '123')
      assert.deepEqual(diagnosticLogs[0][1].body, { present: true, type: 'accessor' })
      assert.deepEqual(diagnosticLogs[0][1].rawBody, { present: false, type: 'undefined' })
    })
  } finally {
    await server.close()
    globalThis.fetch = previousFetch
    globalThis.FormData = previousFormData
    globalThis.createImageBitmap = previousCreateImageBitmap
    globalThis.document = previousDocument
    delete globalThis.__telegramUploadMocks
  }
})
