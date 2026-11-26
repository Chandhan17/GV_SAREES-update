import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('product details keeps Add to Cart on-page and Buy Now uses isolated selected-quantity checkout', () => {
  const details = readSource('../src/pages/ProductDetailsPage.jsx')
  const addToCartHandler = details.match(/const handleAddToCart = \(\) => \{[\s\S]*?\n\s*\}/)?.[0]
  const buyNowHandler = details.match(/const handleBuyNow = \(\) => \{[\s\S]*?\n\s*\}/)?.[0]
  const cartPage = readSource('../src/pages/CartPage.jsx')

  assert.ok(addToCartHandler)
  assert.ok(buyNowHandler)
  assert.match(addToCartHandler, /addToCart\(product, quantity\)/)
  assert.doesNotMatch(addToCartHandler, /navigate|startBuyNow/)
  assert.match(buyNowHandler, /startBuyNow\(product, quantity\)/)
  assert.match(buyNowHandler, /navigate\('\/cart\?mode=buy-now'\)/)
  assert.match(details, /aria-busy=\{buyNowProcessing\}/)
  assert.match(details, /Math\.min\(product\.availableStock, current \+ 1\)/)
  assert.match(cartPage, /buyNowItem \? \[buyNowItem\] : \[\]\) : cartItems/)
  assert.match(cartPage, /Your saved cart is unchanged/)
  assert.match(cartPage, /createCheckoutReservation/)
  assert.match(cartPage, /checkoutReservation/)
})

test('navbar search focuses an independent input and submits through the catalogue search query', () => {
  const navbar = readSource('../src/components/Navbar.jsx')

  assert.match(navbar, /placeholder="Search sarees, collections\.\.\."/)
  assert.match(navbar, /searchInputRef\.current\?\.focus\(\)/)
  assert.match(navbar, /navigate\(query \? `\/products\?search=\$\{encodeURIComponent\(query\)\}` : '\/products'\)/)
  assert.match(navbar, /event\.key === 'Escape'/)
  assert.match(navbar, /aria-label="Close search"/)
  assert.doesNotMatch(navbar, /mobileFiltersOpen|setMobileFiltersOpen/)
})

test('catalogue spacing uses compact padding and keeps its filter/results layout', () => {
  const productsPage = readSource('../src/pages/ProductsPage.jsx')

  assert.match(productsPage, /pb-12 pt-6 lg:px-10 lg:pb-16 lg:pt-8/)
  assert.match(productsPage, /pb-6 min-\[769px\]:flex-row/)
  assert.match(productsPage, /mt-4 grid gap-6 min-\[769px\]:mt-6/)
  assert.match(productsPage, /data-scroll-results/)
  assert.doesNotMatch(productsPage, /py-14 lg:px-10 lg:py-20/)
})

test('Back to Shop is directly after admin settings and targets the customer homepage', () => {
  const adminLayout = readSource('../src/components/AdminLayout.jsx')
  const settingsPosition = adminLayout.indexOf("{ label: 'Settings', to: '/admin/settings'")
  const shopPosition = adminLayout.indexOf('Back to Shop')

  assert.ok(settingsPosition >= 0)
  assert.ok(shopPosition > settingsPosition)
  assert.match(adminLayout, /to="\/"/)
  assert.match(adminLayout, /<Store className=/)
  assert.match(adminLayout, /<NavLink\s+to="\/"\s+end/)
  for (const route of ['/admin', '/admin/products', '/admin/products/new', '/admin/orders', '/admin/settings']) {
    assert.ok(adminLayout.includes(route))
  }
})

test('customer routes are lazy-loaded within the existing store layout', () => {
  const app = readSource('../src/App.jsx')

  for (const [page, route] of [
    ['ProductsPage', '/products'],
    ['ProductDetailsPage', '/products/:id'],
    ['CartPage', '/cart'],
  ]) {
    assert.ok(app.includes(`const ${page} = lazy(() => import('./pages/${page}'))`))
    assert.ok(!app.includes(`import ${page} from './pages/${page}'`))

    const routeStart = app.indexOf(`path="${route}"`)
    const routeEnd = app.indexOf('\n      <Route', routeStart)
    const routeSource = app.slice(routeStart, routeEnd === -1 ? undefined : routeEnd)
    assert.ok(routeStart >= 0, `Expected route ${route}`)
    assert.match(routeSource, /<CustomerRoute>/)
    assert.ok(routeSource.includes(`<${page} />`))
  }

  assert.match(app, /import HomePage from '\.\/pages\/HomePage'/)
  assert.match(app, /function CustomerRoute\(\{ children \}\)[\s\S]*?<StoreLayout>[\s\S]*?<Suspense fallback=\{<div role="status" className="p-10 text-center text-brand-dusty">Loading page\.\.\.<\/div>\}>/)
  assert.match(app, /path="\/products\/:id"/)
  assert.match(app, /<ProtectedRoute>[\s\S]*?<AdminDashboardPage \/>/)
})

test('shared admin layout owns page headings while individual pages provide their introductions', () => {
  const adminLayout = readSource('../src/components/AdminLayout.jsx')
  const dashboard = readSource('../src/pages/AdminDashboardPage.jsx')
  const orders = readSource('../src/pages/AdminOrders.jsx')
  const settings = readSource('../src/pages/AdminStoreSettingsPage.jsx')

  assert.match(adminLayout, /<h1 className="font-display[^>]*>\{pageTitle\}<\/h1>/)
  assert.match(dashboard, /A quick view of your catalogue and customer orders\./)
  assert.match(dashboard, /Manage product listings, pricing, images and stock\./)
  assert.match(orders, /Review customer orders, payment status, and fulfillment\./)
  assert.match(settings, /Set the WhatsApp destination used for optional, post-payment order messages\./)
  assert.doesNotMatch(dashboard, /Store overview|<h2[^>]*>Products<\/h2>|Add a new product<\/h2>/)
  assert.doesNotMatch(orders, /<h1[^>]*>Manage Orders<\/h1>/)
  assert.doesNotMatch(settings, /<h2[^>]*>Store Contact<\/h2>/)
})

test('admin routes share a viewport-fixed sidebar and independently scrollable desktop content', () => {
  const app = readSource('../src/App.jsx')
  const adminLayout = readSource('../src/components/AdminLayout.jsx')
  const globalStyles = readSource('../src/index.css')

  assert.equal((app.match(/<AdminLayout>/g) || []).length, 4)
  assert.match(adminLayout, /admin-layout-sidebar[^`]*lg:translate-x-0/)
  assert.match(adminLayout, /admin-layout-sidebar__navigation min-h-0 flex-1/)
  assert.match(adminLayout, /admin-layout-sidebar__account mt-auto shrink-0/)
  assert.doesNotMatch(adminLayout, /lg:static/)
  assert.match(globalStyles, /\.admin-layout-sidebar\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh;/s)
  assert.match(globalStyles, /position:\s*fixed;[\s\S]*?width:\s*18rem;/)
  assert.match(globalStyles, /margin-left:\s*18rem;[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/)
})
