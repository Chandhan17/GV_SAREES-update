import { useCart } from '../hooks/useCart'
import { useToast } from '../hooks/useToast'
import { formatINR } from '../utils/formatters'

export default function QuickShopModal({ product, isOpen, onClose }) {
  const { addToCart } = useCart()
  const { error, success } = useToast()

  if (!isOpen || !product) return null

  const handleAddToCart = () => {
    try {
      addToCart(product)
      success(`${product.name} added to cart.`)
      onClose()
    } catch (addError) {
      error(addError?.message || 'Unable to add this product to the cart.')
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4" role="dialog" aria-modal="true" aria-labelledby="quick-shop-title">
      <div className="w-full max-w-md rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-royal">
        <h3 id="quick-shop-title" className="font-display text-3xl text-brand-burgundy">Add to cart</h3>
        <p className="mt-2 text-sm text-brand-dusty">{product.name}</p>
        <p className="mt-1 text-sm font-semibold text-brand-burgundy">{formatINR(product.price)}</p>
        <p className="mt-3 text-xs text-brand-dusty">
          {product.availableStock} available. Stock is not reserved until you begin online checkout.
        </p>
        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-outline flex-1" onClick={onClose}>Continue browsing</button>
          <button type="button" className="btn-gold flex-1" onClick={handleAddToCart} disabled={product.availableStock <= 0}>
            Add to cart
          </button>
        </div>
      </div>
    </div>
  )
}
