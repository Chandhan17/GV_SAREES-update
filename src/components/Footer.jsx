import { ArrowRight, ArrowUpRight, Camera, MapPin, MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import clientConfig from '../config/clientConfig'
import { STORE_WHATSAPP_NUMBER } from '../config/storeContact'
import BrandLogo from './BrandLogo'
import { categories } from '../config/categories'

const STORE_INSTAGRAM_URL = 'https://www.instagram.com/gv_sarees_pdtr/'
const STORE_WHATSAPP_URL = `https://wa.me/${STORE_WHATSAPP_NUMBER.slice(1)}`
const DEVELOPER_INSTAGRAM_URL = 'https://www.instagram.com/sai_chandhan/'
const STORE_MAPS_URL = 'https://www.google.com/maps/search/?api=1&query=GV%20Sarees%2C%205%2F997%2C%20Rameshwaram-Bollavaram%20Road%2C%20Vinayaka%20Nagar%2C%20Proddatur%2C%20Andhra%20Pradesh%20516360'

function SocialLink({ href, label, icon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex min-h-11 items-center gap-2 text-sm text-brand-burgundy transition hover:text-brand-rose-gold"
    >
      {icon}
      <span>{label}</span>
    </a>
  )
}

export default function Footer() {
  return (
    <footer className="bg-brand-blush text-brand-dusty">
      <div className="mx-auto max-w-[1440px] px-5 pt-12 sm:pt-14 lg:px-10 lg:pt-16">
        <div className="grid gap-x-8 gap-y-10 border-b border-brand-pale-rose pb-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-10">
          <div className="max-w-sm">
            <Link to="/" className="inline-flex items-center gap-3">
              <BrandLogo alt="GV Sarees logo" className="h-14 w-14 shrink-0" loading="lazy" />
              <span className="font-display text-2xl text-brand-burgundy">{clientConfig.brandName}</span>
            </Link>
            <p className="mt-4 text-sm leading-6 text-brand-dusty">
              A considered edit of sarees for everyday elegance and celebrations.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4">
              <SocialLink href={STORE_INSTAGRAM_URL} label="Instagram" icon={<Camera size={17} aria-hidden="true" />} />
              <SocialLink href={STORE_WHATSAPP_URL} label="WhatsApp" icon={<MessageCircle size={17} aria-hidden="true" />} />
            </div>
          </div>

          <div>
            <h2 className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-burgundy">Shop</h2>
            <nav aria-label="Shop collections" className="mt-4 space-y-3 text-sm text-brand-burgundy">
              <Link to="/products" className="block transition hover:text-brand-rose-gold">All collections</Link>
              {categories.slice(0, 4).map((category) => (
                <Link
                  key={category}
                  to={`/products?category=${encodeURIComponent(category)}`}
                  className="block transition hover:text-brand-rose-gold"
                >
                  {category}
                </Link>
              ))}
            </nav>
          </div>

          <div>
            <h2 className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-burgundy">Explore</h2>
            <nav aria-label="Explore GV Sarees" className="mt-4 space-y-3 text-sm text-brand-burgundy">
              <Link to="/products" className="inline-flex min-h-11 items-center gap-2 transition hover:text-brand-rose-gold">
                Browse the catalogue <ArrowRight size={14} aria-hidden="true" />
              </Link>
              <a
                href={STORE_INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 items-center gap-2 transition hover:text-brand-rose-gold"
              >
                <Camera size={17} aria-hidden="true" /> Instagram
              </a>
              <a
                href={STORE_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 items-center gap-2 transition hover:text-brand-rose-gold"
              >
                <MessageCircle size={17} aria-hidden="true" /> WhatsApp
              </a>
            </nav>
          </div>

          <div>
            <h2 className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-brand-burgundy">Visit our store</h2>
            <address className="mt-4 not-italic text-sm leading-6 text-brand-dusty">
              <span className="block font-semibold text-brand-burgundy">GV Sarees</span>
              <span className="block">5/997, Rameshwaram–Bollavaram Road (Vinayaka Nagar St),</span>
              <span className="block">Opposite Chowdamma Temple,</span>
              <span className="block">Near Arts College Circle,</span>
              <span className="block">Proddatur, Andhra Pradesh – 516360, India.</span>
            </address>
            <a
              href={STORE_MAPS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-burgundy transition hover:text-brand-rose-gold"
            >
              <MapPin size={17} aria-hidden="true" /> Get Directions <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
        </div>

      </div>
      <div className="w-full border-t border-brand-pale-rose text-brand-secondary">
        <div
          className="mx-auto flex max-w-[1440px] flex-col items-center justify-center gap-0.5 px-5 py-5 text-center font-display text-sm leading-6 sm:text-base"
          style={{ minHeight: 96 }}
        >
          <p>© <span className="font-body text-xs font-normal">2026</span> GV Sarees. All rights reserved.</p>
          <p>
            Made by{' '}
            <a
              href={DEVELOPER_INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-brand-burgundy transition hover:text-brand-rose-gold"
            >
              sai_chandhan
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}
