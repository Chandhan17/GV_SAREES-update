import { createElement, useState } from 'react'
import { LayoutDashboard, LogOut, Menu, Package, Plus, Settings, ShoppingCart, Store, X } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import BrandLogo from './BrandLogo'
import { useAuth } from '../hooks/useAuth'

const navigation = [
  { label: 'Overview', to: '/admin', icon: LayoutDashboard, end: true },
  { label: 'Products', to: '/admin/products', icon: Package },
  { label: 'Add Product', to: '/admin/products/new', icon: Plus },
  { label: 'Orders', to: '/admin/orders', icon: ShoppingCart },
  { label: 'Settings', to: '/admin/settings', icon: Settings },
]

function Navigation({ onNavigate }) {
  return (
    <nav className="space-y-1" aria-label="Admin navigation">
      {navigation.map(({ label, to, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition ${
              isActive
                ? 'bg-brand-blush text-brand-burgundy shadow-sm'
                : 'text-brand-dusty hover:bg-brand-blush/70 hover:text-brand-burgundy'
            }`
          }
        >
          {createElement(Icon, { className: 'h-[18px] w-[18px]', strokeWidth: 1.8 })}
          {label}
        </NavLink>
      ))}
      <div className="mt-3 border-t border-brand-pale-rose/60 pt-3">
        <NavLink
          to="/"
          end
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl border px-3 py-3 text-sm font-semibold transition ${
              isActive
                ? 'border-brand-rose-gold/40 bg-brand-blush text-brand-burgundy'
                : 'border-transparent text-brand-burgundy hover:border-brand-rose-gold/30 hover:bg-brand-blush/70'
            }`
          }
        >
          <Store className="h-[18px] w-[18px]" strokeWidth={1.8} />
          Back to Shop
        </NavLink>
      </div>
    </nav>
  )
}

export default function AdminLayout({ children }) {
  const { user, logoutAdmin } = useAuth()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  const pageTitle = location.pathname === '/admin/orders'
    ? 'Orders'
    : location.pathname === '/admin/settings'
      ? 'Settings'
    : location.pathname === '/admin/products/new'
      ? 'Add Product'
      : location.pathname === '/admin/products'
        ? 'Products'
        : 'Overview'

  return (
    <div className="admin-layout-shell min-h-screen bg-brand-soft-white text-brand-burgundy">
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-brand-burgundy/30 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={`admin-layout-sidebar fixed inset-y-0 left-0 z-40 w-72 border-r border-brand-pale-rose/70 bg-brand-card-white px-5 py-6 transition-transform lg:translate-x-0 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="flex shrink-0 items-center justify-between">
          <NavLink to="/admin" className="flex items-center gap-3" onClick={() => setMobileOpen(false)}>
            <BrandLogo alt="GV Sarees" className="h-11 w-11 shrink-0" />
            <div>
              <p className="font-display text-xl leading-none text-brand-burgundy">GV Sarees</p>
              <p className="mt-1 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-brand-dusty">Admin studio</p>
            </div>
          </NavLink>
          <button type="button" className="rounded-lg p-2 text-brand-dusty lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-10 flex min-h-0 flex-1 flex-col">
          <p className="mb-3 shrink-0 px-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-brand-dusty/70">Workspace</p>
          <div className="admin-layout-sidebar__navigation min-h-0 flex-1">
            <Navigation onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>

        <div className="admin-layout-sidebar__account mt-auto shrink-0 border-t border-brand-pale-rose/60 pt-4">
          <div className="mb-3 truncate px-3 text-xs text-brand-dusty" title={user?.email}>{user?.email || 'Admin account'}</div>
          <button type="button" onClick={logoutAdmin} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-brand-dusty transition hover:bg-brand-blush hover:text-brand-burgundy">
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="admin-layout-content min-w-0">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-brand-pale-rose/70 bg-brand-soft-white/95 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <button type="button" className="rounded-xl border border-brand-pale-rose bg-brand-card-white p-2.5 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <div>
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-brand-rose-gold">Store management</p>
              <h1 className="font-display text-2xl text-brand-burgundy md:text-3xl">{pageTitle}</h1>
            </div>
          </div>
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-brand-burgundy">Welcome back</p>
            <p className="max-w-[220px] truncate text-xs text-brand-dusty">{user?.email}</p>
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
