import ProductCard from './ProductCard'

export default function ProductGrid({ products, onBuyNow, onAddToCart, columns = 4, prioritizeFirstImage = false }) {
  if (!products.length) {
    return (
      <div className="rounded-[2rem] border border-dashed border-brand-rose-gold/50 bg-brand-card-white px-6 py-14 text-center">
        <p className="font-display text-2xl text-brand-dusty">No pieces found.</p>
        <p className="mt-2 text-sm text-brand-dusty">Try another search or explore a different collection.</p>
      </div>
    )
  }

  return (
    <div className={`grid grid-cols-2 items-start gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-3 ${columns === 6 ? 'xl:grid-cols-6' : 'xl:grid-cols-4'}`}>
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          onBuyNow={onBuyNow}
          onAddToCart={onAddToCart}
          priority={prioritizeFirstImage && index === 0}
        />
      ))}
    </div>
  )
}
