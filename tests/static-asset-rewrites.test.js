import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

for (const configName of ['vercel.json', 'vercel.dev.json']) {
  const config = JSON.parse(readFileSync(new URL(`../${configName}`, import.meta.url), 'utf8'))
  const spaRewrite = config.rewrites.find(({ destination }) => destination === '/index.html')

  test(`${configName} keeps static assets out of the SPA fallback`, () => {
    assert.ok(spaRewrite)

    const sourcePattern = new RegExp(`^${spaRewrite.source}$`)
    for (const assetPath of [
      '/Banner.png',
      '/Banner-480.avif',
      '/Banner-960.avif',
      '/Banner-1200.avif',
      '/Banner-1672.avif',
      '/Banner-480.webp',
      '/Banner-960.webp',
      '/Banner-1200.webp',
      '/Banner-1672.webp',
      '/logo.png',
      '/logo-112.png',
      '/icons.svg',
      '/favicon.svg',
      '/assets/app.css',
      '/assets/app.js',
    ]) {
      assert.equal(sourcePattern.test(assetPath), false, `${assetPath} should not match the SPA rewrite`)
    }

    assert.equal(sourcePattern.test('/admin/products/new'), true)
    assert.equal(sourcePattern.test('/products/sample-product'), true)
    assert.equal(sourcePattern.test('/api/image/sample-file-id'), false)
  })
}
