import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Footer from './components/Footer'
import Navbar from './components/Navbar'
import ProtectedRoute from './components/ProtectedRoute'
import AdminLayout from './components/AdminLayout'
import clientConfig from './config/clientConfig'
import AdminLoginPage from './pages/AdminLoginPage'
import HomePage from './pages/HomePage'
import useScrollManager from './hooks/useScrollManager'
import NotFoundPage from './pages/NotFoundPage'

const CartPage = lazy(() => import('./pages/CartPage'))
const ProductDetailsPage = lazy(() => import('./pages/ProductDetailsPage'))
const ProductsPage = lazy(() => import('./pages/ProductsPage'))
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'))
const AdminOrdersPage = lazy(() => import('./pages/AdminOrders'))
const CustomerReservationsPage = lazy(() => import('./pages/CustomerReservationsPage'))
const AdminStoreSettingsPage = lazy(() => import('./pages/AdminStoreSettingsPage'))

function StoreLayout({ children }) {
  return (
    <div className="min-h-screen bg-brand-soft-white text-brand-burgundy">
      <Navbar />
      <main>{children}</main>
      <Footer />
    </div>
  )
}

function CustomerRoute({ children }) {
  return (
    <StoreLayout>
      <Suspense fallback={<div role="status" className="p-10 text-center text-brand-dusty">Loading page...</div>}>
        {children}
      </Suspense>
    </StoreLayout>
  )
}

function hexToRgbTriplet(hex) {
  const clean = String(hex || '').replace('#', '')
  if (clean.length !== 6) return null
  const intVal = Number.parseInt(clean, 16)
  if (Number.isNaN(intVal)) return null
  const r = (intVal >> 16) & 255
  const g = (intVal >> 8) & 255
  const b = intVal & 255
  return `${r} ${g} ${b}`
}

function App() {
  useScrollManager()

  useEffect(() => {
    const softWhite = hexToRgbTriplet(clientConfig.theme.softWhite)
    const lightBlush = hexToRgbTriplet(clientConfig.theme.lightBlush)
    const paleRose = hexToRgbTriplet(clientConfig.theme.paleRose)
    const roseGold = hexToRgbTriplet(clientConfig.theme.roseGold)
    const dustyRose = hexToRgbTriplet(clientConfig.theme.dustyRose)
    const heading = hexToRgbTriplet(clientConfig.theme.heading)
    const secondary = hexToRgbTriplet(clientConfig.theme.secondary)
    const buttonText = hexToRgbTriplet(clientConfig.theme.buttonText)
    const burgundy = hexToRgbTriplet(clientConfig.theme.burgundy || clientConfig.theme.heading)
    const white = hexToRgbTriplet(clientConfig.theme.white || clientConfig.theme.cardWhite)
    const cardWhite = hexToRgbTriplet(clientConfig.theme.cardWhite)

    if (softWhite) document.documentElement.style.setProperty('--color-soft-white-rgb', softWhite)
    if (lightBlush) document.documentElement.style.setProperty('--color-light-blush-rgb', lightBlush)
    if (paleRose) document.documentElement.style.setProperty('--color-pale-rose-rgb', paleRose)
    if (roseGold) document.documentElement.style.setProperty('--color-rose-gold-rgb', roseGold)
    if (dustyRose) document.documentElement.style.setProperty('--color-dusty-rose-rgb', dustyRose)
    if (heading) document.documentElement.style.setProperty('--color-heading-rgb', heading)
    if (secondary) document.documentElement.style.setProperty('--color-secondary-rgb', secondary)
    if (buttonText) document.documentElement.style.setProperty('--color-button-text-rgb', buttonText)
    if (dustyRose) document.documentElement.style.setProperty('--color-accent-rgb', roseGold)
    if (cardWhite) document.documentElement.style.setProperty('--color-card-white-rgb', cardWhite)
    if (burgundy) document.documentElement.style.setProperty('--color-burgundy-rgb', burgundy)
    if (burgundy) document.documentElement.style.setProperty('--color-heading-rgb', burgundy)
    if (white) document.documentElement.style.setProperty('--color-white-rgb', white)

    document.title = clientConfig.brandName
    const favicon = document.querySelector("link[rel='icon']")
    if (favicon) {
      favicon.setAttribute('href', clientConfig.logo)
    }
  }, [])

  return (
    <Routes>
      <Route
        path="/"
        element={
          <StoreLayout>
            <HomePage />
          </StoreLayout>
        }
      />
      <Route
        path="/products"
        element={<CustomerRoute><ProductsPage /></CustomerRoute>}
      />
      <Route
        path="/products/:id"
        element={<CustomerRoute><ProductDetailsPage /></CustomerRoute>}
      />
      <Route
        path="/cart"
        element={<CustomerRoute><CartPage /></CustomerRoute>}
      />
      <Route
        path="/orders"
        element={
          <StoreLayout>
            <Suspense fallback={<div className="p-10 text-center text-brand-dusty">Loading orders...</div>}>
              <CustomerReservationsPage />
            </Suspense>
          </StoreLayout>
        }
      />
      <Route path="/reservations" element={<Navigate to="/orders" replace />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/login" element={<AdminLoginPage />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout>
              <Suspense fallback={<div className="p-10 text-center text-brand-dusty">Loading admin panel...</div>}>
                <AdminDashboardPage />
              </Suspense>
            </AdminLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/orders"
        element={
          <ProtectedRoute>
            <AdminLayout>
              <Suspense fallback={<div className="p-10 text-center text-brand-dusty">Loading orders...</div>}>
                <AdminOrdersPage />
              </Suspense>
            </AdminLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute>
            <AdminLayout>
              <Suspense fallback={<div className="p-10 text-center text-brand-dusty">Loading settings...</div>}>
                <AdminStoreSettingsPage />
              </Suspense>
            </AdminLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/products/*"
        element={
          <ProtectedRoute>
            <AdminLayout>
              <Suspense fallback={<div className="p-10 text-center text-brand-dusty">Loading products...</div>}>
                <AdminDashboardPage />
              </Suspense>
            </AdminLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/home" element={<Navigate to="/" replace />} />
      <Route
        path="*"
        element={
          <StoreLayout>
            <NotFoundPage />
          </StoreLayout>
        }
      />
    </Routes>
  )
}

export default App
