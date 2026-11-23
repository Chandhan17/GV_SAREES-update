import { ChevronDown, Menu, Search, ShoppingBag, X } from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import clientConfig from '../config/clientConfig'

function NavigationItem({ item, onNavigate }) {
  const [open, setOpen] = useState(false)

  if (!item.children) {
    return (
      <NavLink to={item.to} onClick={onNavigate} className="nav-link whitespace-nowrap">
        {item.label}
      </NavLink>
    )
  }

  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <div className="flex items-center gap-1">
        <NavLink to={item.to} onClick={onNavigate} className="nav-link whitespace-nowrap">
          {item.label}
        </NavLink>
        <button
          type="button"
          className="rounded-full p-1 transition hover:bg-brand-pale-rose"
          aria-label={`Open ${item.label} menu`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onMouseEnter={() => setOpen(true)}
        >
          <ChevronDown size={13} strokeWidth={1.8} />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-4 w-56 rounded-xl border border-brand-pale-rose/10 bg-brand-blush p-3 shadow-elevated">
          {item.children.map((child) => (
            <Link
              key={child.label}
              to={child.to}
              onClick={onNavigate}
              className="block rounded-lg px-3 py-2.5 text-sm text-brand-burgundy transition hover:bg-brand-soft-white hover:text-brand-burgundy"
            >
              {child.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileSareesOpen, setMobileSareesOpen] = useState(false)

  const closeMenu = () => {
    setMenuOpen(false)
    setMobileSareesOpen(false)
  }

  return (
    <header className="relative z-50 border-b border-brand-pale-rose/60 bg-brand-blush">
      <div className="border-b border-brand-rose-gold/20 bg-brand-dusty px-4 py-2 text-center text-[0.62rem] font-semibold uppercase tracking-[0.2em] text-brand-soft-white md:text-xs">
        {clientConfig.announcement}
      </div>

      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-5 px-4 py-4 lg:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2.5" onClick={closeMenu}>
          <img src="/logo.png" alt="GV Sarees Logo" className="-my-2 h-14 w-14 object-contain" />
          <span className="font-display text-2xl leading-none text-brand-burgundy">{clientConfig.brandName}</span>
        </Link>

        <nav className="hidden items-center gap-4 text-[0.72rem] font-semibold uppercase tracking-[0.08em] xl:flex" aria-label="Primary navigation">
          {clientConfig.navigation.map((item) => (
            <NavigationItem key={item.label} item={item} onNavigate={closeMenu} />
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <Link to="/products" className="rounded-full p-2.5 text-brand-burgundy transition hover:bg-brand-soft-white" aria-label="Search products">
            <Search size={19} strokeWidth={1.8} />
          </Link>
          <Link to="/products" className="rounded-full p-2.5 text-brand-burgundy transition hover:bg-brand-soft-white" aria-label="Open shopping catalogue">
            <ShoppingBag size={19} strokeWidth={1.8} />
          </Link>
          <button
            type="button"
            className="rounded-full p-2.5 text-brand-burgundy transition hover:bg-brand-soft-white xl:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="border-t border-brand-pale-rose/60 bg-brand-blush px-4 py-4 xl:hidden">
          <nav className="mx-auto max-w-[1440px]" aria-label="Mobile navigation">
            {clientConfig.navigation.map((item) => (
              <div key={item.label} className="border-b border-brand-pale-rose/10 last:border-b-0">
                {item.children ? (
                  <>
                    <div className="flex items-center justify-between">
                      <Link to={item.to} onClick={closeMenu} className="block py-3.5 text-sm font-semibold uppercase tracking-[0.1em]">
                        {item.label}
                      </Link>
                      <button
                        type="button"
                        className="p-3"
                        aria-label={`Expand ${item.label} menu`}
                        aria-expanded={mobileSareesOpen}
                        onClick={() => setMobileSareesOpen((value) => !value)}
                      >
                        <ChevronDown className={mobileSareesOpen ? 'rotate-180 transition' : 'transition'} size={17} />
                      </button>
                    </div>
                    {mobileSareesOpen && (
                      <div className="grid grid-cols-2 gap-2 pb-4 pl-3">
                        {item.children.map((child) => (
                          <Link key={child.label} to={child.to} onClick={closeMenu} className="py-2 text-sm text-brand-dusty">
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link to={item.to} onClick={closeMenu} className="block py-3.5 text-sm font-semibold uppercase tracking-[0.1em]">
                    {item.label}
                  </Link>
                )}
              </div>
            ))}
          </nav>
        </div>
      )}
    </header>
  )
}
