import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  getImageUrl,
  normalizeImageItem,
  normalizeImageUrl,
  normalizeImages,
} from '../src/utils/imageHelpers.js'
import { auditProductRecords } from '../scripts/auditTelegramImageUrls.js'

const testToken = 'NOT_A_REAL_TELEGRAM_TOKEN'
const directTelegramUrl = `https://api.telegram.org/file/bot${testToken}/photos/sample.webp`

test('normalizes Telegram file IDs and application proxy URLs', () => {
  assert.equal(getImageUrl({ file_id: 'sample-file-id' }), '/api/image/sample-file-id')
  assert.equal(
    getImageUrl({ url: 'https://store.example/api/image/sample-file-id' }),
    '/api/image/sample-file-id'
  )
})

test('converts legacy Telegram file URLs without retaining the token', () => {
  const normalized = normalizeImageItem(directTelegramUrl)
  assert.equal(normalized.url, '/api/image/photos%2Fsample.webp')
  assert.equal(normalized.file_path, 'photos/sample.webp')
  assert.equal(JSON.stringify(normalized).includes(testToken), false)
  assert.equal(getImageUrl(directTelegramUrl), '/api/image/photos%2Fsample.webp')
  assert.equal(getImageUrl({ file_id: directTelegramUrl }), '/api/image/photos%2Fsample.webp')
  assert.equal(JSON.stringify(normalizeImageItem({ file_id: directTelegramUrl })).includes(testToken), false)
  assert.equal(normalizeImageUrl(directTelegramUrl), '/api/image/photos%2Fsample.webp')
})

test('rejects empty or incomplete Telegram references safely', () => {
  assert.equal(normalizeImageItem(''), null)
  assert.equal(normalizeImageItem(null), null)
  assert.equal(getImageUrl(''), '')
  assert.equal(getImageUrl(`https://api.telegram.org/file/bot${testToken}`), '')
  assert.equal(normalizeImageUrl(`https://api.telegram.org/file/bot${testToken}`), null)
  assert.equal(normalizeImageUrl(''), '')
  assert.equal(
    JSON.stringify(normalizeImages([directTelegramUrl, '', null])).includes(testToken),
    false
  )
})

test('audit reports only document IDs and field paths for direct or encoded URLs', () => {
  const result = auditProductRecords([
    {
      id: 'product-a',
      data: {
        images: [
          { url: directTelegramUrl, file_id: 'sample-file-id' },
          { file_id: 'safe-file-id' },
        ],
        thumbnailUrl: `https://store.example/api/image/${encodeURIComponent(directTelegramUrl)}`,
        sizeChartImage: '/api/image/safe-file-id',
      },
    },
    {
      id: 'product-b',
      data: { images: [{ file_id: 'another-safe-id' }] },
    },
    {
      id: 'product-c',
      data: { thumbnail: `https://api.telegram.org/file/bot${testToken}` },
    },
  ])
  const serialized = JSON.stringify(result)

  assert.equal(result.productDocumentsChecked, 3)
  assert.equal(result.imageReferencesChecked, 6)
  assert.equal(result.potentiallyExposedReferences, 3)
  assert.deepEqual(result.affectedDocuments, [
    {
      documentId: 'product-a',
      fields: ['images[0].url', 'thumbnailUrl'],
    },
    {
      documentId: 'product-c',
      fields: ['thumbnail'],
    },
  ])
  assert.equal(serialized.includes(testToken), false)
  assert.equal(serialized.includes('sample.webp'), false)
  assert.equal(serialized.includes('https://'), false)
})

test('normalizes direct Telegram URLs nested inside existing proxy URLs', () => {
  const wrappedUrl = `/api/image/${encodeURIComponent(directTelegramUrl)}`
  const normalized = normalizeImageItem(wrappedUrl)

  assert.equal(normalized.url, '/api/image/photos%2Fsample.webp')
  assert.equal(JSON.stringify(normalized).includes(testToken), false)
})

test('product reads and writes normalize the size-chart URL', () => {
  const service = readFileSync(new URL('../src/services/productService.js', import.meta.url), 'utf8')
  assert.match(service, /sizeChartImage:\s*normalizeImageUrl\(data\.sizeChartImage\)/)
  assert.match(service, /sizeChartImage:\s*normalizeImageUrl\(payload\.sizeChartImage\)/)
  assert.match(service, /data\.sizeChartImage\s*=\s*normalizeImageUrl\(payload\.sizeChartImage\)/)
})
