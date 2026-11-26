import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { productCreateSchema } from '../server/validation.js'
import {
  assertPerformanceSeedTarget,
  createPerformanceSeedDocuments,
  PERFORMANCE_PLACEHOLDER_IMAGE,
  PERFORMANCE_SEED_PRODUCTS,
  seedPerformanceProducts,
} from '../scripts/seed-performance-products.mjs'

const validExplicitEnv = {
  FIREBASE_PROJECT_ID: 'demo-gv-sarees',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
}

test('performance product seeding rejects non-demo targets, production overrides and credentials', () => {
  assert.deepEqual(
    assertPerformanceSeedTarget({ explicitEnv: validExplicitEnv, inheritedEnv: {} }),
    { projectId: 'demo-gv-sarees', emulatorHost: '127.0.0.1:8080' },
  )

  for (const explicitEnv of [
    { ...validExplicitEnv, FIREBASE_PROJECT_ID: 'production-project' },
    { ...validExplicitEnv, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' },
  ]) {
    assert.throws(
      () => assertPerformanceSeedTarget({ explicitEnv, inheritedEnv: {} }),
      /requires demo-gv-sarees and its local Firestore Emulator/,
    )
  }

  for (const inheritedEnv of [
    { FIREBASE_PROJECT_ID: 'production-project' },
    { GCLOUD_PROJECT: 'production-project' },
    { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' },
    { GOOGLE_APPLICATION_CREDENTIALS: 'do-not-use.json' },
    { FIREBASE_CONFIG: '{"projectId":"production-project"}' },
    { FIREBASE_CONFIG: 'null' },
  ]) {
    assert.throws(
      () => assertPerformanceSeedTarget({ explicitEnv: validExplicitEnv, inheritedEnv }),
      /conflict|not allowed|verified/i,
    )
  }
})

test('seed products satisfy the actual product-create schema and use the local placeholder', () => {
  const documents = createPerformanceSeedDocuments()
  const placeholderPath = resolve(process.cwd(), 'public', PERFORMANCE_PLACEHOLDER_IMAGE.slice(1))

  assert.equal(documents.length, PERFORMANCE_SEED_PRODUCTS.length)
  assert.ok(documents.length >= 12)
  assert.equal(new Set(documents.map(({ id }) => id)).size, documents.length)
  assert.equal(existsSync(placeholderPath), true)
  assert.match(readFileSync(placeholderPath, 'utf8'), /<svg\b/)

  for (const { id, data } of documents) {
    const { createdAt, reservedStock, availableStock, inStock, ...productFields } = data
    const result = productCreateSchema.safeParse({
      action: 'create',
      ...productFields,
    })

    assert.match(id, /^performance-seed-v1-\d{3}$/)
    assert.equal(result.success, true)
    assert.equal(data.images[0], PERFORMANCE_PLACEHOLDER_IMAGE)
    assert.equal(reservedStock, 0)
    assert.equal(availableStock, data.totalStock)
    assert.equal(inStock, data.totalStock > 0)
    assert.equal(typeof createdAt.toMillis(), 'number')
  }
})

test('seeding verifies the emulator and uses stable document IDs for idempotent writes', async () => {
  const storedDocuments = new Map()
  let commits = 0
  let verificationCount = 0
  const firestore = {
    collection(name) {
      assert.equal(name, 'products')
      return {
        doc(id) {
          return { path: `${name}/${id}` }
        },
      }
    },
    batch() {
      const writes = []
      return {
        set(reference, data) {
          writes.push([reference.path, data])
        },
        async commit() {
          commits += 1
          for (const [path, data] of writes) storedDocuments.set(path, data)
        },
      }
    },
  }
  const seed = () => seedPerformanceProducts({
    explicitEnv: validExplicitEnv,
    inheritedEnv: {},
    verifyEmulator: async (target) => {
      verificationCount += 1
      assert.deepEqual(target, { projectId: 'demo-gv-sarees', emulatorHost: '127.0.0.1:8080' })
    },
    createFirestore: () => firestore,
  })

  assert.equal(await seed(), PERFORMANCE_SEED_PRODUCTS.length)
  assert.equal(await seed(), PERFORMANCE_SEED_PRODUCTS.length)
  assert.equal(verificationCount, 2)
  assert.equal(commits, 2)
  assert.equal(storedDocuments.size, PERFORMANCE_SEED_PRODUCTS.length)
})

test('failed emulator verification aborts before initializing Firestore', async () => {
  let firestoreInitialized = false

  await assert.rejects(
    seedPerformanceProducts({
      explicitEnv: validExplicitEnv,
      inheritedEnv: {},
      verifyEmulator: async () => {
        throw new Error('emulator verification failed')
      },
      createFirestore: () => {
        firestoreInitialized = true
        throw new Error('must not initialize')
      },
    }),
    /emulator verification failed/,
  )

  assert.equal(firestoreInitialized, false)
})
