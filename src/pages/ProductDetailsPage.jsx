import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ImageGallery from '../components/ImageGallery'
import { fetchProductById } from '../services/productService'
import { formatINR } from '../utils/formatters'
import { getImageUrl } from '../utils/imageHelpers'
import { useCart } from '../hooks/useCart'
import { useToast } from '../hooks/useToast'

export default function ProductDetailsPage() {
  const { id } = useParams()
  const [product, setProduct] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [buyNowProcessing, setBuyNowProcessing] = useState(false)
  const buyNowLockRef = useRef(false)
  const { addToCart, startBuyNow } = useCart()
  const navigate = useNavigate()
  const { success, error: toastError } = useToast()

  const handleAddToCart = () => {
    try {
      addToCart(product, quantity)
      success(`${product.name} added to cart.`)
    } catch (err) {
      toastError(err?.message || 'Unable to add this product to the cart.')
    }
  }

  const handleBuyNow = () => {
    if (buyNowLockRef.current || !product) return
    buyNowLockRef.current = true
    setBuyNowProcessing(true)
    try {
      startBuyNow(product, quantity)
      navigate('/cart?mode=buy-now')
    } catch (err) {
      buyNowLockRef.current = false
      setBuyNowProcessing(false)
      toastError(err?.message || 'Unable to start checkout for this product.')
    }
  }

  useEffect(() => {
    setQuantity(1)
    setBuyNowProcessing(false)
    buyNowLockRef.current = false

    async function loadProduct() {
      try {
        setLoading(true)
        setError('')
        const data = await fetchProductById(id)
        if (!data) setError('Product not found.')
        else setProduct(data)
      } catch {
        setError('Unable to load product details.')
      } finally {
        setLoading(false)
      }
    }

    loadProduct()
  }, [id])

  if (loading) {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-8 lg:px-10 lg:py-10">
        <div className="grid animate-pulse gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:gap-10">
          <div className="aspect-[4/5] rounded-[2rem] bg-brand-pale-rose" />
          <div className="space-y-4 bg-brand-card-white p-5 lg:pt-1">
            <div className="h-4 w-1/4 rounded bg-brand-pale-rose" />
            <div className="h-12 w-3/4 rounded bg-brand-pale-rose" />
            <div className="h-6 w-1/3 rounded bg-brand-pale-rose" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-24 text-center lg:px-10">
        <p className="eyebrow-line justify-center">Catalogue note</p>
        <h1 className="mt-5 font-display text-4xl text-brand-dusty">{error || 'Product not available.'}</h1>
        <Link to="/products" className="btn-outline mt-8">
          Back to collections <ArrowLeft size={16} />
        </Link>
      </div>
    )
  }

  const sizeChartImageUrl = getImageUrl(product.sizeChartImage) || product.sizeChartImage
  const details = [
    ['Fabric', product.fabric],
    ['Size / length', product.sizeLength],
  ].filter(([, value]) => value)
  const sellingPrice = Number(product.price || 0)
  const originalPrice = Number(product.originalPrice ?? product.compareAtPrice ?? product.regularPrice ?? product.mrp ?? 0)
  const hasDiscount = originalPrice > sellingPrice

  return (
    <div className="mx-auto max-w-[1440px] px-5 py-6 lg:px-10 lg:py-8">
      <Link to="/products" className="mb-4 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-dusty hover:text-brand-dusty">
        <ArrowLeft size={15} /> Back to the edit
      </Link>

      <div className="grid items-start gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:gap-10">
        <ImageGallery images={product.images} alt={product.name} />

        <section className="p-1 sm:p-2 lg:pt-1">
          <p className="eyebrow-line">{product.category || 'Collection'}</p>
          <h1 className="mt-3 font-display text-4xl leading-tight text-brand-burgundy sm:text-5xl">{product.name}</h1>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-2xl font-semibold text-brand-burgundy">{formatINR(sellingPrice)}</p>
            {hasDiscount && (
              <p className="text-sm text-brand-secondary">
                <span className="line-through">{formatINR(originalPrice)}</span>
                <span className="ml-2 text-brand-rose-gold">({Math.round(((originalPrice - sellingPrice) / originalPrice) * 100)}% off)</span>
              </p>
            )}
          </div>
          <div className="my-5 h-px bg-brand-pale-rose" />

          {product.description && <p className="whitespace-pre-line text-[0.95rem] leading-7 text-brand-dusty">{product.description}</p>}

          {product.availableStock <= 0 ? (
            <p className="mt-5 rounded-xl bg-brand-blush px-4 py-3 text-sm font-semibold text-brand-dusty">Out of stock. Please check back later.</p>
          ) : (
            <div className="mt-5 flex items-center gap-2 text-sm text-brand-dusty">
              <Check size={17} className="text-brand-rose-gold" /> {product.availableStock} available · stock is held securely when you begin payment
            </div>
          )}

          <div className="mt-5 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold text-brand-dusty">Quantity</span>
            <div className="flex items-center rounded-full border border-brand-pale-rose/70 bg-brand-card-white">
              <button
                type="button"
                onClick={() => setQuantity((current) => Math.max(1, current - 1))}
                disabled={quantity <= 1 || product.availableStock <= 0}
                aria-label="Decrease quantity"
                className="rounded-l-full px-4 py-2 text-brand-burgundy transition hover:bg-brand-blush disabled:opacity-40"
              >
                −
              </button>
              <span className="min-w-10 text-center text-sm font-semibold text-brand-burgundy" aria-live="polite">{quantity}</span>
              <button
                type="button"
                onClick={() => setQuantity((current) => Math.min(product.availableStock, current + 1))}
                disabled={quantity >= product.availableStock}
                aria-label="Increase quantity"
                className="rounded-r-full px-4 py-2 text-brand-burgundy transition hover:bg-brand-blush disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button type="button" className="btn-gold w-full shadow-soft" onClick={handleAddToCart} disabled={product.availableStock <= 0}>
              {product.availableStock <= 0 ? 'Out of stock' : 'Add to cart'}
            </button>
            <button
              type="button"
              className="btn-outline w-full"
              onClick={handleBuyNow}
              disabled={product.availableStock <= 0 || buyNowProcessing}
              aria-busy={buyNowProcessing}
            >
              {product.availableStock <= 0 ? 'Out of stock' : buyNowProcessing ? 'Preparing checkout…' : 'Buy now'}
            </button>
          </div>

          {details.length > 0 && (
            <dl className="mt-6 grid gap-4 border-y border-brand-pale-rose/10 py-5 sm:grid-cols-2">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-brand-dusty">{label}</dt>
                  <dd className="mt-1 text-sm text-brand-dusty">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {product.sizeChartText && (
            <p className="mt-5 text-sm leading-6 text-brand-dusty">
              <span className="font-semibold text-brand-dusty">Size note:</span> {product.sizeChartText}
            </p>
          )}

          {sizeChartImageUrl && (
            <img
              src={sizeChartImageUrl}
              alt="Size chart"
              className="mt-5 max-h-64 w-full rounded-xl border border-brand-rose-gold/20 object-contain"
              loading="lazy"
              onError={(event) => {
                event.currentTarget.onerror = null
                event.currentTarget.remove()
              }}
            />
          )}

          <Link to="/products" className="mt-4 flex items-center justify-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-dusty">
            Continue browsing <ArrowRight size={15} />
          </Link>
        </section>
      </div>

    </div>
  )
}
