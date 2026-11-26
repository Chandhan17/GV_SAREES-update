import { ArrowUpRight, ShoppingCart } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatINR } from '../utils/formatters'
import { FALLBACK_IMAGE, getPrimaryImageUrl } from '../utils/imageHelpers'

export default function ProductCard({ product, onBuyNow, onAddToCart, priority = false }) {
  const [isBuyNowProcessing, setIsBuyNowProcessing] = useState(false)
  const buyNowLockRef = useRef(false)
  const primaryImage = getPrimaryImageUrl(
    product.images,
    FALLBACK_IMAGE
  )
  const sellingPrice = Number(product.price || 0)
  const originalPrice = Number(product.originalPrice ?? product.compareAtPrice ?? product.regularPrice ?? product.mrp ?? 0)
  const hasDiscount = originalPrice > sellingPrice
  const discountPercent = hasDiscount ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100) : 0

  const handleBuyNow = async () => {
    if (buyNowLockRef.current || !onBuyNow) return
    buyNowLockRef.current = true
    setIsBuyNowProcessing(true)
    try {
      await onBuyNow(product)
    } catch {
      buyNowLockRef.current = false
      setIsBuyNowProcessing(false)
    }
  }

  return (
    <article className="group overflow-hidden rounded-2xl border border-brand-pale-rose bg-brand-white">
      <Link to={`/products/${product.id}`} className="relative block overflow-hidden">
        <div className="aspect-[4/5] overflow-hidden bg-brand-white">
          <img
            src={primaryImage}
            alt={product.name}
            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-105"
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
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
          onClick={() => onAddToCart?.(product)}
          disabled={product.availableStock <= 0}
          className="btn-outline mt-4 w-full !px-3 !py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShoppingCart size={15} /> Add to cart
        </button>
        <button
          type="button"
          onClick={handleBuyNow}
          disabled={product.availableStock <= 0 || isBuyNowProcessing}
          aria-busy={isBuyNowProcessing}
          className="mt-3 w-full text-xs font-bold uppercase tracking-[0.18em] text-brand-dusty underline decoration-brand-rose-gold decoration-2 underline-offset-4 transition hover:text-brand-rose-gold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {product.availableStock <= 0 ? 'Out of stock' : isBuyNowProcessing ? 'Preparing checkout…' : 'Buy now'}
        </button>
      </div>
    </article>
  )
}
