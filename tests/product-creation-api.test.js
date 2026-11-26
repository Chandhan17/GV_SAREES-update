import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createAdminProductsHandler,
  getAdminIdempotencyDocumentId,
  getIdempotencyKey,
  normalizeProductCreatePayload,
} from '../api/admin/products.js'
import { productCreateSchema } from '../server/validation.js'

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
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

function createMockFirestore({ failWrite = false } = {}) {
  const data = new Map()
  let nextId = 1
  let transactionQueue = Promise.resolve()

  const collection = (name) => ({
    doc(id) {
      const docId = id || `generated-${nextId++}`
      const key = `${name}/${docId}`
      return {
        id: docId,
        key,
        async set(value) {
          if (failWrite) throw new Error('Firestore write failed')
          data.set(key, value)
        },
      }
    },
  })

  return {
    collection,
    getData: () => data,
    runTransaction(callback) {
      const operation = transactionQueue.then(async () => {
        const transaction = {
          async get(ref) {
            return {
              exists: data.has(ref.key),
              data: () => data.get(ref.key),
            }
          },
          set(ref, value) {
            if (failWrite) throw new Error('Firestore write failed')
            data.set(ref.key, value)
          },
        }
        return callback(transaction)
      })
      transactionQueue = operation.catch(() => {})
      return operation
    },
  }
}

function validProduct(overrides = {}) {
  return {
    action: 'create',
    name: 'Red Banarasi Saree',
    price: 4999,
    category: 'Pattu',
    description: 'A traditional saree',
    fabric: 'Silk',
    images: ['/api/image/sample-file-id'],
    sizeLength: '5.5 m',
    sizeChartText: 'Please verify length',
    sizeChartImage: '/api/image/sample-chart-id',
    totalStock: 10,
    lowStockThreshold: 2,
    ...overrides,
  }
}

test('valid admin product creation writes the existing product schema and returns an ID', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1', email: 'admin@example.com' }),
    firestore: createMockFirestore(),
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { 'idempotency-key': 'create_key_1234567890' }, body: validProduct() }, res)

  assert.equal(res.statusCode, 201)
  assert.equal(JSON.parse(res.body).success, true)
  assert.match(JSON.parse(res.body).productId, /^generated-/)
})

test('missing idempotency key returns HTTP 400', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore: createMockFirestore(),
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {}, body: validProduct() }, res)

  assert.equal(res.statusCode, 400)
})

test('invalid and conflicting idempotency headers return HTTP 400', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore: createMockFirestore(),
  })

  const invalid = createResponse()
  await handler({ method: 'POST', headers: { 'idempotency-key': 'bad key' }, body: validProduct() }, invalid)
  assert.equal(invalid.statusCode, 400)

  const conflict = createResponse()
  await handler({
    method: 'POST',
    headers: {
      'idempotency-key': 'create_key_1234567890',
      'x-idempotency-key': 'create_key_0987654321',
    },
    body: validProduct(),
  }, conflict)
  assert.equal(conflict.statusCode, 400)
})

test('X-Idempotency-Key is accepted', () => {
  const key = getIdempotencyKey({ headers: { 'x-idempotency-key': 'create_key_1234567890' } })
  assert.equal(key, 'create_key_1234567890')
})

test('matching Idempotency-Key and X-Idempotency-Key are accepted', () => {
  const key = getIdempotencyKey({
    headers: {
      'idempotency-key': 'create_key_1234567890',
      'x-idempotency-key': 'create_key_1234567890',
    },
  })
  assert.equal(key, 'create_key_1234567890')
})

test('missing bearer token is rejected before product creation', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async (req, res) => {
      void req
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: false, message: 'Unauthorized: Missing token' }))
      return null
    },
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: {}, body: validProduct() }, res)

  assert.equal(res.statusCode, 401)
})

test('invalid Firebase token and authenticated non-admin are rejected', async () => {
  for (const message of ['Unauthorized: Invalid token', 'Unauthorized: Admin access required']) {
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
    await handler({ method: 'POST', headers: { authorization: 'Bearer invalid' }, body: validProduct() }, res)
    assert.equal(res.statusCode, 401)
  }
})

test('missing fields, invalid types and unexpected privileged fields are rejected', () => {
  assert.equal(productCreateSchema.safeParse(validProduct({ name: '' })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ price: '4999' })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ totalStock: 1.5 })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ reservedStock: 0 })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ isAdmin: true })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ createdAt: 'client' })).success, false)
  assert.equal(productCreateSchema.safeParse(validProduct({ documentId: 'custom-id' })).success, false)
})

test('missing required fields and invalid image payload return HTTP 400', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore: createMockFirestore(),
  })

  for (const body of [
    { action: 'create', name: 'Missing fields' },
    validProduct({ images: [] }),
    validProduct({ images: [42] }),
  ]) {
    const res = createResponse()
    await handler({ method: 'POST', headers: {}, body }, res)
    assert.equal(res.statusCode, 400)
  }
})

test('Firebase Admin write failure returns HTTP 500', async () => {
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore: createMockFirestore({ failWrite: true }),
  })
  const res = createResponse()

  await handler({ method: 'POST', headers: { 'idempotency-key': 'create_key_1234567890' }, body: validProduct() }, res)

  assert.equal(res.statusCode, 500)
})

test('same idempotency key and payload returns the existing product ID', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const headers = { 'idempotency-key': 'create_key_1234567890' }

  const first = createResponse()
  await handler({ method: 'POST', headers, body: validProduct() }, first)
  const firstId = JSON.parse(first.body).productId

  const second = createResponse()
  await handler({ method: 'POST', headers, body: validProduct() }, second)

  assert.equal(second.statusCode, 201)
  assert.equal(JSON.parse(second.body).productId, firstId)
})

test('same idempotency key with different payload returns conflict', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const headers = { 'idempotency-key': 'create_key_1234567890' }

  const first = createResponse()
  await handler({ method: 'POST', headers, body: validProduct() }, first)
  const conflict = createResponse()
  await handler({ method: 'POST', headers, body: validProduct({ name: 'Different product' }) }, conflict)

  assert.equal(conflict.statusCode, 409)
})

test('different admins using the same key do not collide', async () => {
  const firestore = createMockFirestore()
  const key = 'create_key_1234567890'

  const firstHandler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const first = createResponse()
  await firstHandler({ method: 'POST', headers: { 'idempotency-key': key }, body: validProduct() }, first)
  const firstId = JSON.parse(first.body).productId

  const secondHandler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-2' }),
    firestore,
  })
  const second = createResponse()
  await secondHandler({ method: 'POST', headers: { 'idempotency-key': key }, body: validProduct() }, second)
  const secondId = JSON.parse(second.body).productId

  assert.notEqual(firstId, secondId)
  assert.notEqual(
    getAdminIdempotencyDocumentId('admin-1', key),
    getAdminIdempotencyDocumentId('admin-2', key),
  )
})

test('concurrent same-admin requests create only one product', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const headers = { 'idempotency-key': 'create_key_1234567890' }

  const responses = await Promise.all([
    (async () => {
      const res = createResponse()
      await handler({ method: 'POST', headers, body: validProduct() }, res)
      return res
    })(),
    (async () => {
      const res = createResponse()
      await handler({ method: 'POST', headers, body: validProduct() }, res)
      return res
    })(),
  ])

  const productIds = responses.map((res) => JSON.parse(res.body).productId)
  assert.equal(responses[0].statusCode, 201)
  assert.equal(responses[1].statusCode, 201)
  assert.equal(productIds[0], productIds[1])
  assert.equal([...firestore.getData().keys()].filter((key) => key.startsWith('products/')).length, 1)
})

test('persisted product document contains expected normalized fields', async () => {
  const firestore = createMockFirestore()
  const handler = createAdminProductsHandler({
    verifyAdminUser: async () => ({ uid: 'admin-1' }),
    firestore,
  })
  const res = createResponse()

  await handler({
    method: 'POST',
    headers: { 'idempotency-key': 'create_key_1234567890' },
    body: validProduct(),
  }, res)

  const productId = JSON.parse(res.body).productId
  const product = firestore.getData().get(`products/${productId}`)
  assert.equal(product.name, 'Red Banarasi Saree')
  assert.equal(product.price, 4999)
  assert.equal(product.category, 'Pattu')
  assert.equal(product.description, 'A traditional saree')
  assert.equal(product.fabric, 'Silk')
  assert.equal(product.totalStock, 10)
  assert.equal(product.reservedStock, 0)
  assert.equal(product.availableStock, 10)
  assert.equal(product.inStock, true)
  assert.equal(product.lowStockThreshold, 2)
  assert.equal(product.sizeLength, '5.5 m')
  assert.equal(product.sizeChartText, 'Please verify length')
  assert.equal(product.sizeChartImage, '/api/image/sample-chart-id')
  assert.ok(product.createdAt)
})

test('normalized product document preserves existing inventory and content fields', () => {
  const data = normalizeProductCreatePayload(productCreateSchema.parse(validProduct()))
  assert.equal(data.reservedStock, 0)
  assert.equal(data.availableStock, data.totalStock)
  assert.equal(data.inStock, true)
  assert.equal(data.lowStockThreshold, 2)
  assert.deepEqual(
    Object.keys(data).sort(),
    ['availableStock', 'category', 'createdAt', 'description', 'fabric', 'images', 'inStock', 'lowStockThreshold', 'name', 'price', 'reservedStock', 'sizeChartImage', 'sizeChartText', 'sizeLength', 'totalStock'].sort(),
  )
})

test('browser createProduct sends bearer and idempotency headers and no addDoc', () => {
  const service = readFileSync(new URL('../src/services/productService.js', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  assert.match(service, /export async function createProduct/)
  assert.match(service, /Authorization:\s*`Bearer \$\{token\}`/)
  assert.match(service, /Idempotency-Key/)
  assert.match(service, /action:\s*'create'/)
  assert.match(service, /\/api\/admin\/products/)
  assert.doesNotMatch(service, /\baddDoc\s*\(/)
  assert.doesNotMatch(service, /\bserverTimestamp\s*\(/)
  assert.match(page, /useRef/)
  assert.match(page, /productCreationKeyRef/)
  assert.match(page, /generateProductCreationKey/)
  assert.match(page, /createProduct\([\s\S]*generateProductCreationKey/)
})

test('admin product form resets on Add route entry and reinitializes for each edited product', () => {
  const page = readFileSync(new URL('../src/pages/AdminDashboardPage.jsx', import.meta.url), 'utf8')
  assert.match(page, /const initializeForm = useCallback\(\(product = null\)/)
  assert.match(page, /useLayoutEffect\(\(\) => \{\s*if \(isAddProduct\) resetForm\(\)\s*\}, \[isAddProduct, resetForm\]\)/)
  assert.match(page, /const handleEdit = \(product\) => initializeForm\(product\)/)
  assert.match(page, /setForm\(\{\s*\.\.\.initialForm\s*\}\)/)
  assert.match(page, /setEditingId\(''\)/)
  assert.match(page, /setExistingImages\(\[\]\)/)
  assert.match(page, /clearNewImageState\(\)/)
  assert.match(page, /setSizeChartFile\(null\)/)
  assert.match(page, /setError\(''\)/)
  assert.match(page, /setStatus\(''\)/)
  assert.match(page, /setExistingImages\(normalizeImages\(product\.images \|\| \[\]\)\)/)
})
