import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createServer } from 'vite'
import { createAdminProductsHandler } from '../api/admin/products.js'
import { productUpdateSchema } from '../server/validation.js'

function createResponse() {
  return {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = JSON.stringify(payload)
      return this
    },
    end(payload = '') {
      this.body = payload
      return this
    },
  }
}

function createMockFirestore({ exists = true, failWrite = false } = {}) {
  let product = exists
    ? {
        name: 'Old Name',
        price: 1000,
        category: 'Pattu',
        description: 'Old description',
        fabric: 'Silk',
        images: ['/api/image/old-image'],
        sizeLength: '5.5 m',
        sizeChartText: 'Old chart text',
        sizeChartImage: '/api/image/old-chart',
        totalStock: 10,
        reservedStock: 2,
        availableStock: 8,
        inStock: true,
        lowStockThreshold: 2,
        createdAt: 'old-server-timestamp',
      }
    : null

  return {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            key: `${name}/${id}`,
            async get() {
              if (name === 'products') {
                return {
                  exists: product !== null,
                  data: () => product,
                }
              }
              return { exists: false, data: () => undefined }
            },
          }
        },
      }
    },
    async runTransaction(callback) {
      const transaction = {
        async get(ref) {
          return {
            exists: ref.key === 'products/p1' && product !== null,
            data: () => product,
          }
        },
        update(ref, updates) {
          if (failWrite) throw new Error('Firestore transaction failed')
          if (ref.key === 'products/p1') product = { ...product, ...updates }
        },
      }
      return callback(transaction)
    },
    getProduct: () => product,
  }
}

function validUpdate(overrides = {}) {
  return {
    action: 'update',
    productId: 'p1',
    name: 'New Name',
    price: 1500,
    category: 'Fancy',
    description: 'New description',
    fabric: 'Cotton',
    images: ['/api/image/new-image'],
    sizeLength: '6 m',
    sizeChartText: 'New chart text',
    sizeChartImage: '/api/image/new-chart',
    ...overrides,
  }
}

test('valid authenticated admin update transactionally updates editable fields', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1', email: 'admin@example.com' }),
    firestore,
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {}, body: validUpdate() }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).productId, 'p1')
  const product = firestore.getProduct()
  assert.equal(product.name, 'New Name')
  assert.equal(product.price, 1500)
  assert.equal(product.category, 'Fancy')
  assert.equal(product.description, 'New description')
  assert.equal(product.fabric, 'Cotton')
  assert.equal(product.images[0].url, '/api/image/new-image')
  assert.equal(product.images[0].file_id, 'new-image')
  assert.equal(product.images[0].file_path, null)
  assert.equal(product.images[0].public_id, null)
  assert.equal(product.images[0].telegram_message_id, null)
  assert.equal(product.images[0].telegram_chat_id, null)
  assert.equal(product.sizeLength, '6 m')
  assert.equal(product.sizeChartText, 'New chart text')
  assert.equal(product.sizeChartImage, '/api/image/new-chart')
  assert.equal(product.totalStock, 10)
  assert.equal(product.reservedStock, 2)
  assert.equal(product.availableStock, 8)
  assert.equal(product.inStock, true)
  assert.equal(product.createdAt, 'old-server-timestamp')
})

test('missing authentication and invalid or non-admin authentication are rejected', async () => {
  for (const message of [
    'Unauthorized: Missing token',
    'Unauthorized: Invalid token',
    'Unauthorized: Admin access required',
  ]) {
    const handler = createAdminProductsHandler({
      verifyAdminUser: async (req, res) => {
        void req
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: false, message }))
        return null
      },
    })
    const res = createResponse()
    await handler({ method: 'POST', headers: {}, body: validUpdate() }, res)
    assert.equal(res.statusCode, 401)
  }
})

test('missing product ID and product not found are rejected', async () => {
  const missingId = productUpdateSchema.safeParse({ action: 'update', name: 'New Name' })
  assert.equal(missingId.success, false)

  const firestore = createMockFirestore({ exists: false })
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const res = createResponse()
  await handler({ method: 'POST', headers: {}, body: validUpdate() }, res)
  assert.equal(res.statusCode, 404)
})

test('invalid fields, protected fields and unknown fields are rejected', () => {
  assert.equal(productUpdateSchema.safeParse(validUpdate({ price: '1500' })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ images: [] })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ reservedStock: 0 })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ availableStock: 10 })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ inStock: false })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ createdAt: 'client' })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ adminUid: 'other-admin' })).success, false)
  assert.equal(productUpdateSchema.safeParse(validUpdate({ unknownField: true })).success, false)
  assert.equal(productUpdateSchema.safeParse({ action: 'update', productId: 'p1' }).success, false)
})

test('image and size-chart updates are accepted without Telegram cleanup calls', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const res = createResponse()

  await handler({
    method: 'POST',
    headers: {},
    body: {
      action: 'update',
      productId: 'p1',
      images: ['/api/image/replacement'],
      sizeChartImage: '/api/image/new-size-chart',
    },
  }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(firestore.getProduct().sizeChartImage, '/api/image/new-size-chart')
  assert.equal(firestore.getProduct().images[0].url, '/api/image/replacement')
  assert.equal(firestore.getProduct().images[0].file_id, 'replacement')
})

test('omitted image fields preserve the existing images and size-chart image', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const res = createResponse()

  await handler({
    method: 'POST',
    headers: {},
    body: { action: 'update', productId: 'p1', name: 'Updated Name' },
  }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(firestore.getProduct().images[0], '/api/image/old-image')
  assert.equal(firestore.getProduct().sizeChartImage, '/api/image/old-chart')
})

test('Firestore transaction failure returns HTTP 500', async () => {
  const firestore = createMockFirestore({ failWrite: true })
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {}, body: validUpdate() }, res)

  assert.equal(res.statusCode, 500)
})

test('browser editProduct sends bearer token and no updateDoc', () => {
  const service = readFileSync(new URL('../src/services/productService.js', import.meta.url), 'utf8')
  assert.match(service, /export async function editProduct/)
  assert.match(service, /Authorization:\s*`Bearer \$\{token\}`/)
  assert.match(service, /action:\s*'update'/)
  assert.match(service, /\/api\/admin\/products/)
  assert.doesNotMatch(service, /\bupdateDoc\s*\(/)

  const api = readFileSync(new URL('../api/admin/products.js', import.meta.url), 'utf8')
  assert.match(api, /body\?\.\action === 'update'/)

  const page = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /deleteTelegramMedia/)
  assert.doesNotMatch(page, /\/api\/delete-telegram-media/)
})

test('editProduct sends safe, selectively normalized update payloads using mocks', async (t) => {
  const mocks = {
    calls: [],
    auth: { currentUser: { getIdToken: async () => 'mock-token' } },
    db: {},
  }
  const previousFetch = globalThis.fetch
  globalThis.__productServiceMocks = mocks
  globalThis.fetch = async (url, options) => {
    mocks.calls.push({ url, options })
    return { ok: true, json: async () => ({ productId: 'target-id' }) }
  }

  const server = await createServer({
    appType: 'custom',
    configFile: false,
    plugins: [{
      name: 'product-service-test-mocks',
      enforce: 'pre',
      resolveId(source) {
        if (source === './firebase') return '\0mock-product-firebase'
        if (source === 'firebase/firestore') return '\0mock-product-firestore'
        if (source === './telegramMediaService') return '\0mock-telegram-media'
        return null
      },
      load(id) {
        if (id === '\0mock-product-firebase') {
          return 'const mocks = globalThis.__productServiceMocks; export const auth = mocks.auth; export const db = mocks.db;'
        }
        if (id === '\0mock-product-firestore') {
          return 'export const collection = () => ({}); export const doc = () => ({}); export const getDoc = () => {}; export const getDocs = () => {}; export const orderBy = () => ({}); export const query = () => ({});'
        }
        if (id === '\0mock-telegram-media') return 'export const deleteTelegramMedia = async () => {}'
        return null
      },
    }],
    server: { middlewareMode: true },
    ssr: { noExternal: ['firebase'] },
  })

  try {
    const { editProduct } = await server.ssrLoadModule('/src/services/productService.js')
    const getRequestBody = async (productId, payload) => {
      mocks.calls.length = 0
      await editProduct(productId, payload)
      assert.equal(mocks.calls.length, 1)
      assert.equal(mocks.calls[0].url, '/api/admin/products')
      assert.equal(mocks.calls[0].options.headers.Authorization, 'Bearer mock-token')
      return JSON.parse(mocks.calls[0].options.body)
    }

    await t.test('payload action cannot override update or forward arbitrary fields', async () => {
      const body = await getRequestBody('target-id', {
        action: 'delete',
        productId: 'other-id',
        name: 'Updated Name',
        unexpectedField: true,
      })

      assert.equal(body.action, 'update')
      assert.equal(body.productId, 'target-id')
      assert.equal(body.name, 'Updated Name')
      assert.equal(Object.hasOwn(body, 'unexpectedField'), false)
    })

    await t.test('payload productId cannot change the target product', async () => {
      const body = await getRequestBody('target-id', {
        productId: 'other-id',
        description: 'Updated description',
      })

      assert.equal(body.productId, 'target-id')
      assert.equal(body.description, 'Updated description')
    })

    await t.test('omitted images are not sent as an empty array', async () => {
      const body = await getRequestBody('target-id', { name: 'Updated Name' })

      assert.equal(Object.hasOwn(body, 'images'), false)
    })

    await t.test('omitted sizeChartImage remains omitted', async () => {
      const body = await getRequestBody('target-id', { name: 'Updated Name' })

      assert.equal(Object.hasOwn(body, 'sizeChartImage'), false)
    })

    await t.test('explicit null sizeChartImage is preserved', async () => {
      const body = await getRequestBody('target-id', { sizeChartImage: null })

      assert.equal(Object.hasOwn(body, 'sizeChartImage'), true)
      assert.equal(body.sizeChartImage, null)
    })

    await t.test('explicit images are normalized', async () => {
      const body = await getRequestBody('target-id', { images: ['/api/image/sample-id'] })

      assert.deepEqual(body.images, [{
        url: '/api/image/sample-id',
        public_id: null,
        file_id: 'sample-id',
        file_path: null,
        telegram_message_id: null,
        telegram_chat_id: null,
      }])
    })
  } finally {
    await server.close()
    globalThis.fetch = previousFetch
    delete globalThis.__productServiceMocks
  }
})

test('product creation and delete actions remain in the API', () => {
  const api = readFileSync(new URL('../api/admin/products.js', import.meta.url), 'utf8')
  assert.match(api, /body\?\.\action === 'create'/)
  assert.match(api, /const parse = deleteSchema\.safeParse/)
  assert.match(api, /transaction\.delete/)
})
