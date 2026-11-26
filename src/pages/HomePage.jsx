import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import HeroBanner from '../components/HeroBanner'
import LoadingSkeleton from '../components/LoadingSkeleton'
import ProductGrid from '../components/ProductGrid'
import SectionReveal from '../components/SectionReveal'
import { useProducts } from '../hooks/useProducts'
import { useBestSellers } from '../hooks/useBestSellers'
import { useCart } from '../hooks/useCart'
import { useToast } from '../hooks/useToast'
import { getPrimaryImageUrl } from '../utils/imageHelpers'
import { selectAvailableBestSellers, shouldShowBestSellers } from '../utils/bestSellers'
import clientConfig from '../config/clientConfig'

const collectionDefinitions = [
  { label: 'Pattu Sarees', category: 'Pattu', keywords: ['pattu', 'silk'] },
  { label: 'Fancy Sarees', category: 'Fancy', keywords: ['fancy'] },
  { label: 'Designer Sarees', category: 'Bridal Collection', keywords: ['designer', 'bridal'] },
  { label: 'Cotton Sarees', category: 'Cotton', keywords: ['cotton', 'khadi', 'chettinadu', 'kota cotton', 'narayanapeta'] },
  { label: 'Dress Materials', category: 'Dress materials', keywords: ['dress material'] },
  { label: 'Blouses', search: 'blouse', keywords: ['blouse'] },
]

const priceRanges = [
  { label: 'Under ₹999', minPrice: 0, maxPrice: 999 },
  { label: '₹1,000 – ₹2,999', minPrice: 1000, maxPrice: 2999 },
  { label: '₹3,000 – ₹7,999', minPrice: 3000, maxPrice: 7999 },
  { label: 'Above ₹8,000', minPrice: 8000 },
]

function EmptyProductState({ message = 'Product details will appear here once the catalogue is ready.' }) {
  return (
    <div className="rounded-xl border border-dashed border-brand-pale-rose/20 bg-brand-card-white px-6 py-12 text-center">
      <p className="font-display text-2xl text-brand-dusty">Catalogue coming soon</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-brand-dusty">{message}</p>
      <Link to="/products" className="btn-outline mt-5">
        Browse catalogue <ArrowRight size={16} />
      </Link>
    </div>
  )
}

function CollectionTile({ definition, image }) {
  const query = definition.category
    ? `category=${encodeURIComponent(definition.category)}`
    : `search=${encodeURIComponent(definition.search)}`

  return (
    <Link to={`/products?${query}`} className="group text-center">
      {image ? (
        <div className="mx-auto aspect-square w-full max-w-[120px] overflow-hidden rounded-full border border-brand-rose-gold/30 bg-brand-card-white">
          <img
            src={image}
            alt=""
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            loading="lazy"
          />
        </div>
      ) : (
        <div className="mx-auto flex aspect-square max-w-[190px] items-center justify-center border border-brand-pale-rose/15 px-5 transition group-hover:border-brand-rose-gold group-hover:bg-brand-card-white">
          <span className="font-display text-xl leading-tight text-brand-dusty transition group-hover:text-brand-rose-gold">{definition.label}</span>
        </div>
      )}
      {image && <p className="mt-4 text-sm font-semibold text-brand-dusty transition group-hover:text-brand-rose-gold">{definition.label}</p>}
    </Link>
  )
}

function PriceTile({ range }) {
  const query = new URLSearchParams()
  query.set('minPrice', String(range.minPrice))
  if (range.maxPrice !== undefined) query.set('maxPrice', String(range.maxPrice))

  return (
    <Link
      to={`/products?${query.toString()}`}
      className="group flex min-h-32 w-[48%] shrink-0 snap-start flex-col items-center justify-center border border-brand-pale-rose/10 bg-brand-card-white px-2 text-center transition hover:border-brand-rose-gold hover:bg-brand-dusty hover:text-brand-soft-white sm:w-auto sm:shrink sm:snap-none sm:px-4"
    >
      <span className="font-display text-2xl text-brand-dusty transition group-hover:text-brand-soft-white">{range.label}</span>
      <span className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty transition group-hover:text-brand-soft-white">
        Shop now <ArrowRight className="ml-1 inline" size={13} />
      </span>
    </Link>
  )
}

export default function HomePage() {
  const { products, loading } = useProducts()
  const { productIds: bestSellerIds, loading: bestSellersLoading, error: bestSellersError, reload: reloadBestSellers } = useBestSellers()
  const navigate = useNavigate()
  const { addToCart, startBuyNow } = useCart()
  const { success, error } = useToast()

  const handleAddToCart = (product) => {
    try {
      addToCart(product)
      success(`${product.name} added to cart.`)
    } catch (err) {
      error(err?.message || 'Unable to add this product to the cart.')
    }
  }

  const handleBuyNow = (product) => {
    try {
      startBuyNow(product, 1)
      navigate('/cart?mode=buy-now')
    } catch (err) {
      error(err?.message || 'Unable to start checkout for this product.')
      throw err
    }
  }

  const collectionImages = useMemo(() => {
    const usedProductIds = new Set()
    const usedImageUrls = new Set()

    return collectionDefinitions.map((definition) => {
      const rankedProducts = products
        .map((product) => {
          const searchableText = `${product.name || ''} ${product.category || ''} ${product.fabric || ''}`.toLowerCase()
          const exactCategory = definition.category && product.category === definition.category
          const keywordMatches = definition.keywords?.filter((keyword) => searchableText.includes(keyword)).length || 0
          const searchMatch = definition.search && searchableText.includes(definition.search)
          const score = (exactCategory ? 100 : 0) + keywordMatches * 20 + (searchMatch ? 40 : 0)
          const image = getPrimaryImageUrl(product.images, '')
          return { product, image, score }
        })
        .filter(({ image, score }) => image && score > 0)
        .sort((left, right) => right.score - left.score)

      const distinctMatch = rankedProducts.find(
        ({ product, image }) => !usedProductIds.has(product.id) && !usedImageUrls.has(image)
      )
      const match = distinctMatch || rankedProducts.find(({ image }) => !usedImageUrls.has(image))

      if (match) {
        usedProductIds.add(match.product.id)
        usedImageUrls.add(match.image)
        return match.image
      }

      return ''
    })
  }, [products])
  const newArrivals = products.slice(0, 4)
  const bestSellerProducts = useMemo(
    () => selectAvailableBestSellers(bestSellerIds, products),
    [bestSellerIds, products],
  )
  const showBestSellers = shouldShowBestSellers({
    productsLoading: loading,
    bestSellersLoading,
    error: bestSellersError,
    productCount: bestSellerProducts.length,
  })

  return (
    <div>
      <HeroBanner />

      <div className="mx-auto max-w-[1440px] px-4 pt-12 sm:px-6 lg:px-8 lg:pt-16">
        <SectionReveal>
          <section>
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <p className="section-kicker">{clientConfig.content.collectionKicker}</p>
                <h2 className="section-title text-3xl md:text-4xl">{clientConfig.content.collectionTitle}</h2>
              </div>
              <Link to="/products" className="hidden items-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-rose-gold sm:inline-flex">
                Shop all <ArrowRight size={16} />
              </Link>
            </div>
            <div className="-mx-4 flex snap-x snap-mandatory gap-1 overflow-x-auto overscroll-x-contain px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-x-4 sm:gap-y-8 sm:overflow-visible sm:overscroll-auto sm:px-0 sm:pb-0 lg:grid-cols-6">
              {collectionDefinitions.map((definition, index) => (
                <div key={definition.label} className="w-[31%] min-w-[105px] max-w-[120px] shrink-0 snap-start sm:w-auto sm:min-w-0 sm:max-w-none sm:shrink sm:snap-none">
                  <CollectionTile definition={definition} image={collectionImages[index]} />
                </div>
              ))}
            </div>
          </section>
        </SectionReveal>

        {showBestSellers && (
          <SectionReveal delay={0.05}>
            <section className="mt-16" aria-labelledby="best-sellers-title">
              <div className="mb-8 flex items-end justify-between gap-4">
                <div>
                  <p className="section-kicker">Loved by our customers</p>
                  <h2 id="best-sellers-title" className="section-title text-3xl md:text-4xl">Best Sellers</h2>
                </div>
                {!bestSellersLoading && !bestSellersError && bestSellerProducts.length > 0 && (
                  <Link to="/products?sort=best-selling" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-rose-gold">
                    View all best sellers <ArrowRight size={16} />
                  </Link>
                )}
              </div>
              {loading || bestSellersLoading ? (
                <LoadingSkeleton />
              ) : bestSellersError ? (
                <div className="rounded-xl border border-brand-pale-rose/30 bg-brand-card-white px-6 py-8 text-center">
                  <p className="text-sm text-brand-dusty">{bestSellersError}</p>
                  <button type="button" onClick={reloadBestSellers} className="btn-outline mt-4">
                    Try again
                  </button>
                </div>
              ) : (
                <ProductGrid
                  products={bestSellerProducts}
                  onBuyNow={handleBuyNow}
                  onAddToCart={handleAddToCart}
                  columns={6}
                />
              )}
            </section>
          </SectionReveal>
        )}

        <SectionReveal delay={0.05}>
          <section className="-mx-4 mt-16 bg-brand-blush px-4 py-12 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <div className="mb-8">
              <p className="section-kicker">Find your range</p>
              <h2 className="section-title text-3xl md:text-4xl">Shop by price</h2>
            </div>
            <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain border-l border-t border-brand-pale-rose/10 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-4 sm:gap-0 sm:overflow-visible sm:overscroll-auto sm:pb-0">
              {priceRanges.map((range) => <PriceTile key={range.label} range={range} />)}
            </div>
          </section>
        </SectionReveal>

        <SectionReveal delay={0.05}>
          <section className="mt-16">
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <p className="section-kicker">Just added</p>
                <h2 className="section-title text-3xl md:text-4xl">New arrivals</h2>
              </div>
              <Link to="/products?sort=newest" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-rose-gold">
                View all <ArrowRight size={16} />
              </Link>
            </div>
            {loading ? <LoadingSkeleton /> : newArrivals.length ? <ProductGrid products={newArrivals} onBuyNow={handleBuyNow} onAddToCart={handleAddToCart} /> : <EmptyProductState />}
          </section>
        </SectionReveal>

        <SectionReveal delay={0.05}>
          <section className="-mx-4 mt-16 border-y border-brand-pale-rose bg-brand-blush px-4 py-16 text-center sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <p className="section-kicker">{clientConfig.content.aboutKicker}</p>
            <h2 className="mx-auto mt-3 max-w-2xl font-display text-4xl leading-tight text-brand-dusty md:text-5xl">{clientConfig.content.aboutTitle}</h2>
            <p className="mx-auto mt-5 max-w-xl text-sm leading-7 text-brand-dusty">{clientConfig.content.aboutDescription}</p>
            <Link to="/products" className="btn-gold mt-7">
              Explore the catalogue <ArrowRight size={16} />
            </Link>
          </section>
        </SectionReveal>
      </div>

    </div>
  )
}
