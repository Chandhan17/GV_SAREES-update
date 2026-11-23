import { ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatINR } from '../utils/formatters'
import { FALLBACK_IMAGE, getPrimaryImageUrl } from '../utils/imageHelpers'

export default function ProductCard({ product, onQuickShop }) {
  const primaryImage = getPrimaryImageUrl(
    product.images,
    FALLBACK_IMAGE
  )
  const sellingPrice = Number(product.price || 0)
  const originalPrice = Number(product.originalPrice ?? product.compareAtPrice ?? product.regularPrice ?? product.mrp ?? 0)
  const hasDiscount = originalPrice > sellingPrice
  const discountPercent = hasDiscount ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100) : 0

  return (
    <article className="group overflow-hidden rounded-2xl border border-brand-pale-rose bg-brand-white">
      <Link to={`/products/${product.id}`} className="relative block overflow-hidden">
        <div className="aspect-[4/5] overflow-hidden bg-brand-white">
          <img
            src={primaryImage}
            alt={product.name}
            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-105"
            loading="lazy"
            onError={(event) => {
              event.currentTarget.onerror = null
              event.currentTarget.src = FALLBACK_IMAGE
            }}
          />
        </div>
        <div className="absolute right-3 top-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-white text-brand-burgundy shadow-soft transition group-hover:bg-brand-rose-gold">
            <ArrowUpRight size={17} />
          </span>
        </div>
        {product.availableStock <= 0 && (
          <span className="absolute right-4 top-4 rounded-full bg-brand-dusty px-3 py-1 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-brand-soft-white">
            Out of stock
          </span>
        )}
      </Link>

      <div className="px-4 pb-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-xl leading-tight text-brand-dusty">{product.name}</h3>
            <p className="mt-1 text-sm text-brand-secondary">{product.fabric || product.category || 'GV collection'}</p>
          </div>
          <div className="text-right">
            <p className="whitespace-nowrap text-sm font-semibold text-brand-dusty">{formatINR(sellingPrice)}</p>
            {hasDiscount && (
              <p className="mt-1 whitespace-nowrap text-xs text-brand-secondary">
                <span className="line-through">{formatINR(originalPrice)}</span>
                <span className="ml-1 text-brand-rose-gold">({discountPercent}% off)</span>
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onQuickShop(product)}
          disabled={product.availableStock <= 0}
          className="mt-4 text-xs font-bold uppercase tracking-[0.18em] text-brand-dusty underline decoration-brand-rose-gold decoration-2 underline-offset-4 transition hover:text-brand-rose-gold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {product.availableStock <= 0 ? 'Out of stock' : `${product.availableStock} available · Enquire`}
        </button>
      </div>
    </article>
  )
}
