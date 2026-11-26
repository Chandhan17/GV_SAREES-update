import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import handler from '../api/admin/settings.js'
import {
  getStoreSettings as getServerStoreSettings,
  normalizeStoreWhatsAppNumber,
  updateStoreWhatsAppNumber,
} from '../server/storeSettings.js'

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end(body) { this.body = JSON.parse(body) },
  }
}

test('store WhatsApp number normalizes India and international phone values to E.164', () => {
  assert.equal(normalizeStoreWhatsAppNumber('98765 43210'), '+919876543210')
  assert.equal(normalizeStoreWhatsAppNumber('+44 (20) 7946-0958'), '+442079460958')
  assert.equal(normalizeStoreWhatsAppNumber(''), '')
  for (const invalid of ['+91', '1234567', '1234567890', '+0123456789', '+919876543210 ext 1', '1234567890123456']) {
    assert.equal(normalizeStoreWhatsAppNumber(invalid), null, invalid)
  }
})

test('authorized admin settings update persists the normalized number', async () => {
  let written
  const firestore = {
    collection(name) {
      assert.equal(name, 'settings')
      return {
        doc(id) {
          assert.equal(id, 'store')
          return {
            async set(value, options) {
              written = { value, options }
            },
          }
        },
      }
    },
  }
  const saved = await updateStoreWhatsAppNumber('9876543210', firestore)
  assert.equal(saved.whatsappNumber, '+919876543210')
  assert.equal(written.value.whatsappNumber, '+919876543210')
  assert.equal(written.options.merge, true)
})

test('public settings can be read but unauthorized users cannot update them', async () => {
  const getResponse = createResponse()
  await handler({ method: 'GET' }, getResponse, {
    readSettings: async () => ({ whatsappNumber: '+919876543210' }),
  })
  assert.equal(getResponse.statusCode, 200)
  assert.equal(getResponse.body.settings.whatsappNumber, '+919876543210')

  let saves = 0
  const postResponse = createResponse()
  await handler({ method: 'POST', body: { whatsappNumber: '+919876543210' } }, postResponse, {
    authenticateAdmin: async (_req, res) => {
      res.statusCode = 401
      return null
    },
    saveWhatsAppNumber: async () => { saves += 1 },
  })
  assert.equal(postResponse.statusCode, 401)
  assert.equal(saves, 0)
})

test('checkout loads the configured WhatsApp number from the store settings API', async () => {
  const serviceSource = readFileSync(new URL('../src/services/storeSettingsService.js', import.meta.url), 'utf8')
  const firestore = {
    collection(name) {
      assert.equal(name, 'settings')
      return {
        doc(id) {
          assert.equal(id, 'store')
          return {
            async get() {
              return {
                exists: true,
                data: () => ({ whatsappNumber: '9876543210' }),
              }
            },
          }
        },
      }
    },
  }

  assert.match(serviceSource, /fetch\('\/api\/admin\/settings'\)/)
  assert.deepEqual(await getServerStoreSettings(firestore), { whatsappNumber: '+919876543210' })
})

test('invalid store number is rejected and admin settings route only accepts number updates', async () => {
  const response = createResponse()
  await handler({ method: 'POST', body: { whatsappNumber: 'bad-number' } }, response, {
    authenticateAdmin: async () => ({ uid: 'admin-1' }),
    saveWhatsAppNumber: async (number) => updateStoreWhatsAppNumber(number, {
      collection: () => ({ doc: () => ({ set: async () => {} }) }),
    }),
  })
  assert.equal(response.statusCode, 400)
  assert.match(response.body.message, /valid phone number/)

  const unexpectedFieldResponse = createResponse()
  await handler({
    method: 'POST',
    body: { whatsappNumber: '+919876543210', paymentSecret: 'not-accepted' },
  }, unexpectedFieldResponse, {
    authenticateAdmin: async () => ({ uid: 'admin-1' }),
  })
  assert.equal(unexpectedFieldResponse.statusCode, 400)
})
