import { ArrowRight, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import FiltersBar from '../components/FiltersBar'
import LoadingSkeleton from '../components/LoadingSkeleton'
import ProductGrid from '../components/ProductGrid'
import SectionReveal from '../components/SectionReveal'
import { useProducts } from '../hooks/useProducts'
import { useBestSellers } from '../hooks/useBestSellers'
import { useCart } from '../hooks/useCart'
import { useToast } from '../hooks/useToast'
import { scrollToProductResults, shouldScrollAfterFilterNavigation } from '../utils/scrollManagement'

const initialFilters = {
  search: '',
  fabric: '',
  sizeLength: '',
  minPrice: '',
  maxPrice: '',
  onlyAvailable: false,
  sort: 'most-relevant',
}

const SORT_OPTIONS = [
  { value: 'featured', label: 'Featured' },
  { value: 'most-relevant', label: 'Most relevant' },
  { value: 'best-selling', label: 'Best selling' },
  { value: 'name-asc', label: 'Alphabetically, A–Z' },
  { value: 'name-desc', label: 'Alphabetically, Z–A' },
  { value: 'price-low', label: 'Price, low to high' },
  { value: 'price-high', label: 'Price, high to low' },
  { value: 'date-old', label: 'Date, old to new' },
  { value: 'date-new', label: 'Date, new to old' },
]

function normalizeSortValue(value) {
  return value === 'newest' ? 'date-new' : value || initialFilters.sort
}

function SortSelect({ value, onChange }) {
  return (
    <label className="block">
      <span className="sr-only">Sort by</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="input-field mt-0 normal-case tracking-normal">
        {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

function MobileSortSheet({ value, onChange, onClose }) {
  return (
    <div className="fixed inset-0 z-50 min-[769px]:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-sort-title">
      <button type="button" aria-label="Close sort options" onClick={onClose} className="absolute inset-0 h-full w-full bg-brand-burgundy/30" />
      <section className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[2rem] bg-brand-card-white px-5 pb-8 pt-5 shadow-royal">
        <div className="flex items-center justify-between border-b border-brand-pale-rose/20 pb-4">
          <h2 id="mobile-sort-title" className="font-display text-2xl text-brand-burgundy">Sort by</h2>
          <button type="button" onClick={onClose} aria-label="Close sort options" className="rounded-full p-2 text-brand-dusty transition hover:bg-brand-blush hover:text-brand-burgundy">
            <X size={20} />
          </button>
        </div>
        <div className="mt-2">
          {SORT_OPTIONS.map((option) => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value)
                  onClose()
                }}
                className={`flex w-full items-center justify-between border-b border-brand-pale-rose/10 px-1 py-4 text-left text-sm transition last:border-b-0 ${selected ? 'font-semibold text-brand-burgundy' : 'text-brand-dusty hover:text-brand-burgundy'}`}
              >
                <span>{option.label}</span>
                {selected && <span className="h-2.5 w-2.5 rounded-full bg-brand-rose-gold" aria-label="Selected" />}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function getDateValue(value) {
  if (!value) return 0
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export default function ProductsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [searchParams, setSearchParams] = useSearchParams()
  const categoryFromParams = searchParams.get('category') || ''
  const [filters, setFilters] = useState({
    ...initialFilters,
    search: searchParams.get('search') || '',
    minPrice: searchParams.get('minPrice') || '',
    maxPrice: searchParams.get('maxPrice') || '',
    sort: normalizeSortValue(searchParams.get('sort')),
  })
  const [showAll, setShowAll] = useState(false)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [mobileSortOpen, setMobileSortOpen] = useState(false)
  const [scrollControlsVisible, setScrollControlsVisible] = useState(true)
  const [headerOffset, setHeaderOffset] = useState(0)
  const scrollStopTimerRef = useRef(null)
  const previousFilterLocationRef = useRef(null)
  const resultsScrollFrameRef = useRef(0)
  const mobilePanelOpenRef = useRef(false)
  const desktopSidebarRef = useRef(null)
  const desktopSortRef = useRef(null)
  const { products, loading, error } = useProducts()
  const { addToCart, startBuyNow } = useCart()
  const { success, error: toastError } = useToast()

  const scheduleResultsScroll = useCallback(() => {
    if (resultsScrollFrameRef.current) {
      window.cancelAnimationFrame(resultsScrollFrameRef.current)
    }
    resultsScrollFrameRef.current = window.requestAnimationFrame(() => {
      resultsScrollFrameRef.current = 0
      scrollToProductResults()
    })
  }, [])

  useLayoutEffect(() => {
    const previousLocation = previousFilterLocationRef.current
    previousFilterLocationRef.current = {
      pathname: location.pathname,
      search: location.search,
    }
    if (!previousLocation) return

    const activeElement = document.activeElement
    const isEditingTextFilter = Boolean(
      activeElement?.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')
      && activeElement.closest('[data-product-filter-controls]'),
    )
    if (shouldScrollAfterFilterNavigation({
      pathname: location.pathname,
      previousSearch: previousLocation.search,
      currentSearch: location.search,
      navigationType,
      isEditingTextFilter,
    })) {
      scheduleResultsScroll()
    }
  }, [location.pathname, location.search, navigationType, scheduleResultsScroll])

  useEffect(() => () => {
    if (resultsScrollFrameRef.current) window.cancelAnimationFrame(resultsScrollFrameRef.current)
  }, [])

  const handleAddToCart = (product) => {
    try {
      addToCart(product)
      success(`${product.name} added to cart.`)
    } catch (err) {
      toastError(err?.message || 'Unable to add this product to the cart.')
    }
  }

  const handleBuyNow = (product) => {
    try {
      startBuyNow(product, 1)
      navigate('/cart?mode=buy-now')
    } catch (err) {
      toastError(err?.message || 'Unable to start checkout for this product.')
      throw err
    }
  }

  useEffect(() => {
    mobilePanelOpenRef.current = mobileFiltersOpen || mobileSortOpen
  }, [mobileFiltersOpen, mobileSortOpen])

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 768px)')
    const updateHeaderOffset = () => {
      const header = document.querySelector('header')
      const nextOffset = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0
      setHeaderOffset((currentOffset) => currentOffset === nextOffset ? currentOffset : nextOffset)
    }
    const handleScroll = () => {
      updateHeaderOffset()
      setScrollControlsVisible(true)
      window.clearTimeout(scrollStopTimerRef.current)

      const activeElement = document.activeElement
      const desktopControlFocused = desktopSidebarRef.current?.contains(activeElement) || desktopSortRef.current?.contains(activeElement)
      if (mobilePanelOpenRef.current || desktopControlFocused || window.scrollY <= 8) {
        return
      }

      scrollStopTimerRef.current = window.setTimeout(() => {
        if (!mobilePanelOpenRef.current && !desktopSidebarRef.current?.contains(document.activeElement) && !desktopSortRef.current?.contains(document.activeElement)) {
          setScrollControlsVisible(false)
        }
      }, 1200)
    }

    const handleViewportChange = () => {
      window.clearTimeout(scrollStopTimerRef.current)
      updateHeaderOffset()
      setScrollControlsVisible(true)
    }

    const header = document.querySelector('header')
    const headerResizeObserver = header && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateHeaderOffset)
      : null
    headerResizeObserver?.observe(header)
    updateHeaderOffset()
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', updateHeaderOffset)
    mobileQuery.addEventListener?.('change', handleViewportChange)

    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', updateHeaderOffset)
      mobileQuery.removeEventListener?.('change', handleViewportChange)
      headerResizeObserver?.disconnect()
      window.clearTimeout(scrollStopTimerRef.current)
    }
  }, [])

  const sizeOptions = useMemo(
    () => [...new Set(products.map((product) => String(product.sizeLength || '').trim()).filter(Boolean))].sort(),
    [products]
  )
  const activeFilters = useMemo(
    () => ({
      ...filters,
      search: searchParams.get('search') ?? filters.search,
      minPrice: searchParams.get('minPrice') ?? filters.minPrice,
      maxPrice: searchParams.get('maxPrice') ?? filters.maxPrice,
      sort: normalizeSortValue(searchParams.get('sort') ?? filters.sort),
    }),
    [filters, searchParams]
  )
  const { productIds: bestSellerIds, loading: bestSellersLoading, error: bestSellersError, reload: reloadBestSellers } = useBestSellers(
    activeFilters.sort === 'best-selling',
  )

  const filteredProducts = useMemo(() => {
    const minPrice = Number(activeFilters.minPrice || 0)
    const maxPrice = Number(activeFilters.maxPrice || Number.POSITIVE_INFINITY)
    const query = activeFilters.search.trim().toLowerCase()
    const bestSellerOrder = new Map(bestSellerIds.map((productId, index) => [productId, index]))

    const filtered = products.filter((product) => {
      const searchableText = `${product.name || ''} ${product.fabric || ''} ${product.category || ''}`.toLowerCase()
      const nameMatch = !query || searchableText.includes(query)
      const categoryMatch = !categoryFromParams || product.category === categoryFromParams
      const fabricMatch = !activeFilters.fabric || product.fabric === activeFilters.fabric
      const sizeMatch = !activeFilters.sizeLength || product.sizeLength === activeFilters.sizeLength
      const price = Number(product.price || 0)
      const priceMatch = price >= minPrice && price <= maxPrice
      const availableMatch = !activeFilters.onlyAvailable || product.inStock !== false
      const bestSellerMatch = activeFilters.sort !== 'best-selling' || bestSellerOrder.has(product.id)
      return nameMatch && categoryMatch && fabricMatch && sizeMatch && priceMatch && availableMatch && bestSellerMatch
    })

    return [...filtered].sort((a, b) => {
      if (activeFilters.sort === 'best-selling') {
        return bestSellerOrder.get(a.id) - bestSellerOrder.get(b.id)
      }
      if (activeFilters.sort === 'featured') {
        const featuredA = Boolean(a.featured ?? a.isFeatured)
        const featuredB = Boolean(b.featured ?? b.isFeatured)
        return Number(featuredB) - Number(featuredA)
      }
      if (activeFilters.sort === 'name-asc') return String(a.name || '').localeCompare(String(b.name || ''))
      if (activeFilters.sort === 'name-desc') return String(b.name || '').localeCompare(String(a.name || ''))
      if (activeFilters.sort === 'price-low') return Number(a.price || 0) - Number(b.price || 0)
      if (activeFilters.sort === 'price-high') return Number(b.price || 0) - Number(a.price || 0)
      if (activeFilters.sort === 'date-old') return getDateValue(a.createdAt) - getDateValue(b.createdAt)
      if (activeFilters.sort === 'date-new') return getDateValue(b.createdAt) - getDateValue(a.createdAt)
      return 0
    })
  }, [products, activeFilters, categoryFromParams, bestSellerIds])

  const visibleProducts = showAll ? filteredProducts : filteredProducts.slice(0, 8)

  const updateFilter = (field, value) => {
    setShowAll(false)
    if (field === 'category') {
      const nextParams = new URLSearchParams(searchParams)
      if (value) nextParams.set('category', value)
      else nextParams.delete('category')
      setSearchParams(nextParams)
      return
    }
    if (['search', 'minPrice', 'maxPrice', 'sort'].includes(field)) {
      const nextParams = new URLSearchParams(searchParams)
      const nextValue = field === 'sort' ? normalizeSortValue(value) : value
      if (nextValue) nextParams.set(field, nextValue)
      else nextParams.delete(field)
      setSearchParams(nextParams)
    }
    setFilters((prev) => ({ ...prev, [field]: value }))
  }

  const clearFilters = () => {
    setFilters(initialFilters)
    setSearchParams({})
    setShowAll(false)
    scheduleResultsScroll()
  }

  const applyFilters = () => {
    setShowAll(false)
    scheduleResultsScroll()
  }

  return (
    <div className="mx-auto max-w-[1440px] px-5 pb-12 pt-6 lg:px-10 lg:pb-16 lg:pt-8">
      <SectionReveal>
        <div className="flex flex-col justify-between gap-4 border-b border-brand-pale-rose/10 pb-6 min-[769px]:flex-row min-[769px]:items-end">
          <div>
            <p className="eyebrow-line">The catalogue</p>
            <h1 className="section-title">Find your next drape.</h1>
            <p className="mt-2 max-w-lg text-sm leading-6 text-brand-dusty">
              Explore the available GV Sarees collection, with search, filters and details for every listed piece.
            </p>
          </div>
          <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-rose-gold">
            Back to home <ArrowRight size={16} />
          </Link>
        </div>
      </SectionReveal>

      <div
        className="sticky z-50 -mx-5 mt-6 border-y border-brand-pale-rose/60 bg-brand-soft-white px-5 py-3 shadow-soft transition-[transform,opacity] duration-300 ease-out min-[769px]:hidden"
        style={{
          top: `${headerOffset}px`,
          opacity: scrollControlsVisible ? 1 : 0,
          pointerEvents: scrollControlsVisible ? 'auto' : 'none',
          transform: scrollControlsVisible ? 'translateY(0)' : 'translateY(-1rem)',
        }}
      >
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => {
            setScrollControlsVisible(true)
            setMobileFiltersOpen((open) => !open)
          }} className="btn-outline shrink-0">
            Filters
          </button>
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => {
              setScrollControlsVisible(true)
              setMobileSortOpen(true)
            }} className="input-field mt-0 flex items-center justify-between text-left">
              <span>{SORT_OPTIONS.find((option) => option.value === activeFilters.sort)?.label || 'Most relevant'}</span>
              <span className="text-brand-dusty">⌄</span>
            </button>
          </div>
        </div>
        {mobileFiltersOpen && (
          <div className="mt-4">
            <FiltersBar
              filters={{ ...activeFilters, category: categoryFromParams }}
              onChange={updateFilter}
              onClear={clearFilters}
              onApply={() => {
                applyFilters()
                setMobileFiltersOpen(false)
              }}
              layout="mobile"
              sizeOptions={sizeOptions}
            />
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-6 min-[769px]:mt-6 min-[769px]:grid-cols-[minmax(210px,1fr)_minmax(0,3fr)]">
        <div className="hidden min-[769px]:block min-[769px]:self-stretch">
          <aside
            ref={desktopSidebarRef}
            className="sticky self-start"
            style={{
              top: `${headerOffset}px`,
              maxHeight: `calc(100vh - ${headerOffset}px - 1rem)`,
              overflowY: 'auto',
            }}
          >
            <FiltersBar
              filters={{ ...activeFilters, category: categoryFromParams }}
              onChange={updateFilter}
              onClear={clearFilters}
              onApply={applyFilters}
              layout="sidebar"
              sizeOptions={sizeOptions}
            />
          </aside>
        </div>

        <section data-scroll-results className="min-w-0">
          <div
            ref={desktopSortRef}
            className="sticky z-40 -mx-2 flex items-center justify-between gap-4 border-b border-brand-pale-rose/30 bg-brand-soft-white px-2 py-3 shadow-soft transition-[transform,opacity] duration-300 ease-out"
            style={{
              top: `${headerOffset}px`,
              opacity: scrollControlsVisible ? 1 : 0,
              pointerEvents: scrollControlsVisible ? 'auto' : 'none',
              transform: scrollControlsVisible ? 'translateY(0)' : 'translateY(-1rem)',
            }}
          >
            <div className="min-w-0">
              <p className="text-sm text-brand-dusty">
                {loading
                  ? 'Loading the catalogue…'
                  : activeFilters.sort === 'best-selling' && bestSellersLoading
                    ? 'Loading best sellers…'
                    : `${filteredProducts.length} ${filteredProducts.length === 1 ? 'piece' : 'pieces'} shown`}
              </p>
              {categoryFromParams && (
                <button type="button" onClick={() => updateFilter('category', '')} className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-brand-dusty underline decoration-brand-rose-gold decoration-2 underline-offset-4">
                  {categoryFromParams} ×
                </button>
              )}
            </div>
            <div className="hidden w-56 shrink-0 min-[769px]:block">
              <SortSelect value={activeFilters.sort} onChange={(value) => updateFilter('sort', value)} />
            </div>
          </div>

          <div className="mt-4">
            {loading || (activeFilters.sort === 'best-selling' && bestSellersLoading) ? (
              <LoadingSkeleton />
            ) : error ? (
              <div className="rounded-[2rem] border border-brand-pale-rose/40 bg-brand-card-white p-10 text-center text-brand-dusty">{error}</div>
            ) : activeFilters.sort === 'best-selling' && bestSellersError ? (
              <div className="rounded-[2rem] border border-brand-pale-rose/40 bg-brand-card-white p-10 text-center text-brand-dusty">
                <p>{bestSellersError}</p>
                <button type="button" onClick={reloadBestSellers} className="btn-outline mt-4">Try again</button>
              </div>
            ) : (
              <>
                <ProductGrid products={visibleProducts} onBuyNow={handleBuyNow} onAddToCart={handleAddToCart} prioritizeFirstImage />
                {!showAll && filteredProducts.length > visibleProducts.length && (
                  <div className="pt-10 text-center">
                    <button type="button" onClick={() => setShowAll(true)} className="btn-gold">
                      View more pieces <ArrowRight size={16} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {mobileSortOpen && (
        <MobileSortSheet
          value={activeFilters.sort}
          onChange={(value) => updateFilter('sort', value)}
          onClose={() => setMobileSortOpen(false)}
        />
      )}
    </div>
  )
}
