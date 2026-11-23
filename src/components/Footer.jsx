import { ArrowUpRight, Camera, Mail, MapPin, Phone } from 'lucide-react'
import { Link } from 'react-router-dom'
import clientConfig from '../config/clientConfig'
import { categories } from '../config/categories'

export default function Footer() {
  const currentYear = new Date().getFullYear()
  const whatsappNumber = String(clientConfig.whatsapp || '').replace(/\D/g, '')
  const phoneNumber = String(clientConfig.phone || '').replace(/\D/g, '')
  const instagramUrl = String(clientConfig.instagram || '').trim()
  const address = clientConfig.address?.startsWith('[') ? '' : clientConfig.address
  const mapsUrl = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : ''
  const hasContactDetails = Boolean(address || phoneNumber || clientConfig.email || instagramUrl || whatsappNumber)

  return (
    <footer className="bg-brand-blush text-brand-dusty">
      <div className="mx-auto max-w-[1440px] px-5 py-16 lg:px-10 lg:py-20">
        <div className="grid gap-12 border-b border-brand-pale-rose pb-14 lg:grid-cols-[1.4fr_0.8fr_0.8fr_1fr]">
          <div className="max-w-sm">
            <Link to="/" className="inline-flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full border border-brand-dusty font-display text-xl text-brand-dusty">GV</span>
              <span className="font-display text-2xl text-brand-burgundy">{clientConfig.brandName}</span>
            </Link>
            <p className="mt-6 text-sm leading-7 text-brand-dusty">{clientConfig.tagline}</p>
            <p className="mt-6 text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-brand-secondary">
              Thoughtfully chosen · Beautifully draped
            </p>
          </div>

          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-burgundy">Shop</p>
            <nav className="mt-5 space-y-3 text-sm text-brand-burgundy">
              <Link to="/products" className="block transition hover:text-brand-rose-gold">All collections</Link>
              {categories.slice(0, 4).map((category) => (
                <Link key={category} to={`/products?category=${encodeURIComponent(category)}`} className="block transition hover:text-brand-rose-gold">
                  {category}
                </Link>
              ))}
            </nav>
          </div>

          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-burgundy">Explore</p>
            <div className="mt-5 space-y-3 text-sm text-brand-burgundy">
              <Link to="/products" className="inline-flex items-center gap-2 text-brand-burgundy transition hover:text-brand-rose-gold">
                Browse the catalogue <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>

          {hasContactDetails && <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-dusty">Contact</p>
            <div className="mt-5 space-y-4 text-sm text-brand-dusty">
              {address && mapsUrl && (
                <p className="flex items-start gap-3">
                  <MapPin size={16} className="mt-0.5 shrink-0 text-brand-rose-gold" />
                  <a href={mapsUrl} target="_blank" rel="noreferrer" className="hover:text-brand-rose-gold">{address}</a>
                </p>
              )}
              {phoneNumber && (
                <p className="flex items-center gap-3">
                  <Phone size={16} className="shrink-0 text-brand-rose-gold" />
                  <a href={`tel:+${phoneNumber}`} className="hover:text-brand-rose-gold">+{phoneNumber}</a>
                </p>
              )}
              {clientConfig.email && (
                <p className="flex items-center gap-3">
                  <Mail size={16} className="shrink-0 text-brand-rose-gold" />
                  <a href={`mailto:${clientConfig.email}`} className="hover:text-brand-rose-gold">{clientConfig.email}</a>
                </p>
              )}
              {instagramUrl && (
                <p className="flex items-center gap-3">
                  <Camera size={16} className="shrink-0 text-brand-rose-gold" />
                  <a href={instagramUrl} target="_blank" rel="noreferrer" className="hover:text-brand-rose-gold">Instagram</a>
                </p>
              )}
              {whatsappNumber && <a href={`https://wa.me/${whatsappNumber}`} target="_blank" rel="noreferrer" className="inline-flex text-brand-rose-gold hover:text-brand-dusty">WhatsApp enquiries</a>}
            </div>
          </div>}
        </div>

        <div className="flex flex-col justify-between gap-3 pt-6 text-xs text-brand-secondary sm:flex-row">
          <p>© {currentYear} {clientConfig.brandName}. All rights reserved.</p>
          <p>Made for memorable moments.</p>
        </div>
      </div>
    </footer>
  )
}
