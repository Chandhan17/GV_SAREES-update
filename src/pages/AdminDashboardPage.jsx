import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Package, Plus, ShoppingCart, X } from 'lucide-react'
import { categories, getFabricsForCategory } from '../config/categories'
import { useToast } from '../hooks/useToast'
import { createProduct, editProduct, fetchProducts, removeProduct } from '../services/productService'
import { subscribeOrders } from '../services/orderService'
import { uploadMultipleImages, uploadSingleImage } from '../services/telegramUploadService'
import { adjustProductInventory } from '../services/reservationService'
import { formatINR } from '../utils/formatters'
import { getImageUrl, getPrimaryImageUrl, normalizeImages } from '../utils/imageHelpers'

const DEFAULT_DESCRIPTION = `Length: 5.5 mtr
Blouse: 0.8 mtr`

const initialForm = {
  name: '', price: '', category: categories[0], customCategory: '',
  description: DEFAULT_DESCRIPTION, fabric: getFabricsForCategory(categories[0])[0] || '',
  customFabric: '', sizeLength: '', sizeChartText: '', sizeChartImage: '',
  totalStock: '0', lowStockThreshold: '2', stockAdjustment: '',
}

function StatCard({ label, value, detail, icon: Icon, tone = 'rose' }) {
  return (
    <div className="rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-brand-dusty">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-brand-burgundy">{value}</p>
          <p className="mt-1 text-xs text-brand-dusty">{detail}</p>
        </div>
        <span className={`rounded-xl p-3 ${tone === 'green' ? 'bg-emerald-50 text-emerald-700' : tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-brand-blush text-brand-dusty'}`}>
          {createElement(Icon, { className: 'h-5 w-5', strokeWidth: 1.8 })}
        </span>
      </div>
    </div>
  )
}

function formatDate(value) {
  if (!value) return '--'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleDateString('en-IN')
}

function getTimestamp(value) {
  if (value?.toMillis) return value.toMillis()
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export default function AdminDashboardPage() {
  const location = useLocation()
  const { error: toastError, success } = useToast()
  const isOverview = location.pathname === '/admin'
  const isAddProduct = location.pathname === '/admin/products/new'
  const [form, setForm] = useState(initialForm)
  const [products, setProducts] = useState([])
  const [orders, setOrders] = useState([])
  const [editingId, setEditingId] = useState('')
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [warning, setWarning] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [availabilityFilter, setAvailabilityFilter] = useState('all')
  const [sort, setSort] = useState('newest')
  const [existingImages, setExistingImages] = useState([])
  const [removedImages, setRemovedImages] = useState([])
  const [newImages, setNewImages] = useState([])
  const [newImagePreviews, setNewImagePreviews] = useState([])
  const [sizeChartFile, setSizeChartFile] = useState(null)
  const productCreationKeyRef = useRef('')

  function generateProductCreationKey() {
    if (productCreationKeyRef.current) return productCreationKeyRef.current
    const generated = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    productCreationKeyRef.current =
      typeof generated === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(generated)
        ? generated
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    return productCreationKeyRef.current
  }

  useEffect(() => {
    fetchProducts(true).then(setProducts).catch((err) => setError(err.message || 'Failed to load products.')).finally(() => setLoadingProducts(false))
    const unsubscribe = subscribeOrders(setOrders, (err) => toastError(err?.message || 'Failed to load enquiries.'))
    return unsubscribe
  }, [toastError])

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    return [...products]
      .filter((product) => (!term || `${product.name} ${product.fabric}`.toLowerCase().includes(term)))
      .filter((product) => categoryFilter === 'all' || product.category === categoryFilter)
      .filter((product) => availabilityFilter === 'all' || (availabilityFilter === 'available' ? product.inStock !== false : product.inStock === false))
      .sort((a, b) => sort === 'price-low' ? Number(a.price) - Number(b.price) : sort === 'price-high' ? Number(b.price) - Number(a.price) : sort === 'oldest' ? getTimestamp(a.createdAt) - getTimestamp(b.createdAt) : getTimestamp(b.createdAt) - getTimestamp(a.createdAt))
  }, [products, search, categoryFilter, availabilityFilter, sort])

  const setField = (field, value) => {
    if (field === 'category') {
      if (value === 'other') return setForm((prev) => ({ ...prev, category: value, fabric: 'other' }))
      const fabrics = getFabricsForCategory(value)
      return setForm((prev) => ({ ...prev, category: value, customCategory: '', fabric: fabrics[0] || 'other', customFabric: '' }))
    }
    if (field === 'fabric' && value !== 'other') return setForm((prev) => ({ ...prev, fabric: value, customFabric: '' }))
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const clearNewImageState = () => {
    newImagePreviews.forEach((preview) => preview.startsWith('blob:') && URL.revokeObjectURL(preview))
    setNewImages([])
    setNewImagePreviews([])
  }

  const resetForm = () => {
    setForm(initialForm); setEditingId(''); setExistingImages([]); setRemovedImages([]); clearNewImageState(); setSizeChartFile(null)
    productCreationKeyRef.current = ''
  }

  const handleImageSelect = (event) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    setNewImages((prev) => [...prev, ...files])
    setNewImagePreviews((prev) => [...prev, ...files.map((file) => URL.createObjectURL(file))])
    event.target.value = ''
  }

  const handleSubmit = async (event) => {
    event.preventDefault(); setError(''); setStatus(''); setWarning('')
    const finalCategory = (form.category === 'other' ? form.customCategory : form.category).trim()
    const finalFabric = (form.fabric === 'other' ? form.customFabric : form.fabric).trim()
    if (!form.name.trim() || !form.description.trim()) return setError('Product name and description are required.')
    if (!finalCategory || !finalFabric) return setError('Please select or enter a category and fabric.')
    if (!Number.isFinite(Number(form.price)) || Number(form.price) <= 0) return setError('Enter a valid price greater than zero.')
    if (!Number.isInteger(Number(form.totalStock)) || Number(form.totalStock) < 0) return setError('Initial stock must be a whole number zero or greater.')
    if (!Number.isInteger(Number(form.lowStockThreshold)) || Number(form.lowStockThreshold) < 0) return setError('Low-stock threshold must be a whole number zero or greater.')
    const stockAdjustment = form.stockAdjustment === '' ? undefined : Number(form.stockAdjustment)
    if (editingId && stockAdjustment !== undefined && (!Number.isInteger(stockAdjustment) || stockAdjustment === 0)) {
      return setError('Stock adjustment must be a non-zero whole number, or leave it blank.')
    }
    try {
      setSaving(true)
      let uploadedImages = []
      if (newImages.length) {
        const result = await uploadMultipleImages(newImages)
        uploadedImages = result.success
        if (result.failedCount) setWarning(`${result.failedCount} image(s) failed to upload. ${result.errors?.[0] || ''}`)
      }
      const finalImages = normalizeImages([...existingImages, ...uploadedImages])
      if (!finalImages.length) return setError('At least one product image is required.')
      let sizeChartImageUrl = form.sizeChartImage
      if (sizeChartFile) sizeChartImageUrl = (await uploadSingleImage(sizeChartFile)).url
      const payload = {
        name: form.name.trim(), price: Number(form.price), category: finalCategory, description: form.description.trim(),
        fabric: finalFabric, images: finalImages, sizeLength: form.sizeLength.trim(), sizeChartText: form.sizeChartText.trim(),
        sizeChartImage: sizeChartImageUrl,
      }
      if (editingId) {
        await adjustProductInventory({
          productId: editingId,
          quantityChange: stockAdjustment,
          lowStockThreshold: Math.max(0, Number(form.lowStockThreshold) || 0),
          reason: stockAdjustment !== undefined ? 'Manual admin stock adjustment' : 'Update low-stock threshold',
        })
        await editProduct(editingId, payload); success('Product updated successfully.')
      } else {
        await createProduct({
          ...payload,
          totalStock: Math.max(0, Number(form.totalStock) || 0),
          lowStockThreshold: Math.max(0, Number(form.lowStockThreshold) || 0),
        }, generateProductCreationKey()); success('Product added successfully.')
      }
      setProducts(await fetchProducts(true)); resetForm()
    } catch (err) {
      setError(err.message || 'Failed to save product.')
    } finally { setSaving(false) }
  }

  const handleEdit = (product) => {
    const productCategory = String(product.category || '').trim()
    const categoryExists = categories.includes(productCategory)
    const categoryValue = categoryExists ? productCategory : 'other'
    const productFabric = String(product.fabric || '').trim()
    const fabrics = categoryExists ? getFabricsForCategory(productCategory) : []
    const fabricExists = fabrics.includes(productFabric)
    setEditingId(product.id)
    setForm({ name: product.name || '', price: product.price || '', category: categoryValue, customCategory: categoryExists ? '' : productCategory, description: product.description || DEFAULT_DESCRIPTION, fabric: fabricExists ? productFabric : 'other', customFabric: fabricExists ? '' : productFabric, sizeLength: product.sizeLength || '', sizeChartText: product.sizeChartText || '', sizeChartImage: getImageUrl(product.sizeChartImage) || product.sizeChartImage || '', totalStock: String(product.totalStock ?? 0), lowStockThreshold: String(product.lowStockThreshold ?? 2), stockAdjustment: '' })
    setExistingImages(normalizeImages(product.images || [])); setRemovedImages([]); clearNewImageState(); setSizeChartFile(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async (productId) => {
    if (!window.confirm('Delete this product? This cannot be undone.')) return
    try {
      await removeProduct(productId); setProducts(await fetchProducts(true)); success('Product deleted successfully.')
    } catch (err) { toastError(err.message || 'Failed to delete product.') }
  }

  if (isOverview) {
    const available = products.reduce((sum, product) => sum + (Number(product.availableStock) || 0), 0)
    const reserved = products.reduce((sum, product) => sum + (Number(product.reservedStock) || 0), 0)
    const physical = products.reduce((sum, product) => sum + (Number(product.totalStock) || 0), 0)
    const lowStock = products.filter((product) => product.availableStock > 0 && product.availableStock <= (product.lowStockThreshold ?? 2)).length
    const outOfStock = products.filter((product) => (Number(product.availableStock) || 0) === 0).length
    const activeReservations = orders.filter((order) => order.reservationStatus === 'active').length
    const pending = orders.filter((order) => order.orderStatus === 'initiated').length
    const confirmed = orders.filter((order) => order.orderStatus === 'confirmed').length
    return (
      <div className="space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="section-kicker">Good to see you</p><h2 className="mt-2 font-display text-4xl text-brand-burgundy">Store overview</h2><p className="mt-2 text-sm text-brand-dusty">A quick view of your catalogue and customer enquiries.</p></div>
          <div className="flex gap-2"><Link to="/admin/products/new" className="btn-gold"><Plus className="h-4 w-4" /> Add product</Link><Link to="/admin/orders" className="btn-outline"><ShoppingCart className="h-4 w-4" /> View enquiries</Link></div>
        </div>
        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Physical stock" value={physical} detail={`${products.length} products in catalogue`} icon={Package} />
          <StatCard label="Available stock" value={available} detail={`${reserved} currently reserved`} icon={CheckCircle2} tone="green" />
          <StatCard label="Reserved stock" value={reserved} detail={`${activeReservations} active reservations`} icon={ShoppingCart} tone="amber" />
          <StatCard label="Low stock" value={lowStock} detail={`${outOfStock} out of stock`} icon={AlertCircle} tone="amber" />
          <StatCard label="Pending enquiries" value={pending} detail={`${confirmed} confirmed`} icon={ShoppingCart} tone="amber" />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft"><div className="flex items-center justify-between"><h3 className="text-lg font-semibold">Recent enquiries</h3><Link to="/admin/orders" className="text-sm font-medium text-brand-dusty hover:text-brand-burgundy">View all</Link></div>{!orders.length ? <p className="py-8 text-sm text-brand-dusty">No enquiries yet.</p> : <div className="mt-4 divide-y divide-brand-pale-rose/50">{orders.slice(0, 5).map((order) => <div key={order.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div className="min-w-0"><p className="truncate font-medium">{order.customer?.name || 'Unknown customer'}</p><p className="truncate text-xs text-brand-dusty">{order.productName || 'Product enquiry'} · {formatDate(order.createdAt)}</p></div><span className="rounded-full bg-brand-blush px-2.5 py-1 text-xs text-brand-dusty">{order.orderStatus || 'initiated'}</span></div>)}</div>}</section>
          <section className="rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft"><div className="flex items-center justify-between"><h3 className="text-lg font-semibold">Recently added products</h3><Link to="/admin/products" className="text-sm font-medium text-brand-dusty hover:text-brand-burgundy">Manage products</Link></div>{!products.length ? <p className="py-8 text-sm text-brand-dusty">No products yet.</p> : <div className="mt-4 divide-y divide-brand-pale-rose/50">{products.slice(0, 5).map((product) => <div key={product.id} className="flex items-center gap-3 py-3"><img src={getPrimaryImageUrl(product.images, 'https://placehold.co/60x60/FFF8F7/92716C?text=GV')} alt="" className="h-12 w-12 rounded-lg object-cover" /><div className="min-w-0"><p className="truncate font-medium">{product.name}</p><p className="text-xs text-brand-dusty">{product.category} · {formatINR(product.price)}</p></div></div>)}</div>}</section>
        </div>
      </div>
    )
  }

  const availableFabrics = form.category !== 'other' ? getFabricsForCategory(form.category) : []
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="section-kicker">{isAddProduct ? 'Catalogue' : 'Catalogue management'}</p><h2 className="mt-2 font-display text-3xl text-brand-burgundy">{isAddProduct ? 'Add a new product' : 'Products'}</h2><p className="mt-1 text-sm text-brand-dusty">{isAddProduct ? 'Add product details, images and availability.' : `${products.length} products in your catalogue`}</p></div>{!isAddProduct && <Link to="/admin/products/new" className="btn-gold"><Plus className="h-4 w-4" /> Add product</Link>}</div>
      {(isAddProduct || editingId) && <form onSubmit={handleSubmit} className="space-y-6 rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft md:p-7">
        <div className="grid gap-5 md:grid-cols-2"><div className="md:col-span-2"><h3 className="text-lg font-semibold">Basic information</h3><p className="mt-1 text-sm text-brand-dusty">Use clear details customers can understand.</p></div>
          <label className="text-sm font-medium">Product name<input className="input-field mt-1" value={form.name} onChange={(e) => setField('name', e.target.value)} required /></label>
          <label className="text-sm font-medium">Selling price (INR)<input className="input-field mt-1" type="number" min="1" step="0.01" value={form.price} onChange={(e) => setField('price', e.target.value)} required /></label>
          {!editingId && <label className="text-sm font-medium">Initial stock<input className="input-field mt-1" type="number" min="0" step="1" value={form.totalStock} onChange={(e) => setField('totalStock', e.target.value)} required /></label>}
          <label className="text-sm font-medium">Low-stock threshold<input className="input-field mt-1" type="number" min="0" step="1" value={form.lowStockThreshold} onChange={(e) => setField('lowStockThreshold', e.target.value)} required /></label>
          <label className="text-sm font-medium">Category<select className="input-field mt-1" value={form.category} onChange={(e) => setField('category', e.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}<option value="other">Other</option></select></label>
          <label className="text-sm font-medium">Fabric<select className="input-field mt-1" value={form.fabric} onChange={(e) => setField('fabric', e.target.value)}>{availableFabrics.map((item) => <option key={item}>{item}</option>)}<option value="other">Other</option></select></label>
          {form.category === 'other' && <label className="text-sm font-medium">Custom category<input className="input-field mt-1" value={form.customCategory} onChange={(e) => setField('customCategory', e.target.value)} /></label>}
          {form.fabric === 'other' && <label className="text-sm font-medium">Custom fabric<input className="input-field mt-1" value={form.customFabric} onChange={(e) => setField('customFabric', e.target.value)} /></label>}
          <label className="text-sm font-medium md:col-span-2">Description<textarea className="input-field mt-1 min-h-28" value={form.description} onChange={(e) => setField('description', e.target.value)} required /></label>
          <label className="text-sm font-medium">Size / length<input className="input-field mt-1" value={form.sizeLength} onChange={(e) => setField('sizeLength', e.target.value)} placeholder="Optional" /></label>
          <label className="text-sm font-medium">Size chart text<input className="input-field mt-1" value={form.sizeChartText} onChange={(e) => setField('sizeChartText', e.target.value)} placeholder="Optional" /></label>
          <label className="text-sm font-medium md:col-span-2">Size chart image<input className="mt-2 block w-full text-sm" type="file" accept="image/*" onChange={(e) => setSizeChartFile(e.target.files?.[0] || null)} /></label>
        </div>
        <div className="border-t border-brand-pale-rose/60 pt-5"><h3 className="text-lg font-semibold">Images</h3><p className="mt-1 text-sm text-brand-dusty">Keep existing images or add multiple new images.</p><input className="mt-4 block w-full text-sm" type="file" multiple accept="image/*" onChange={handleImageSelect} /></div>
        {(existingImages.length > 0 || newImagePreviews.length > 0) && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[...existingImages.map((image, index) => ({ src: getImageUrl(image), index, existing: true })), ...newImagePreviews.map((src, index) => ({ src, index, existing: false }))].map((image) => <div key={`${image.src}-${image.index}`} className="group relative overflow-hidden rounded-xl border border-brand-pale-rose"><img src={image.src} alt="" className="h-28 w-full object-cover" /><button type="button" className="absolute right-2 top-2 rounded-full bg-brand-burgundy p-1.5 text-white" onClick={() => image.existing ? (setRemovedImages((prev) => [...prev, existingImages[image.index]]), setExistingImages((prev) => prev.filter((_, i) => i !== image.index))) : (setNewImages((prev) => prev.filter((_, i) => i !== image.index)), setNewImagePreviews((prev) => prev.filter((_, i) => i !== image.index)))} aria-label="Remove image"><X className="h-3.5 w-3.5" /></button></div>)}</div>}
        {editingId && <div className="grid gap-3 rounded-xl border border-brand-pale-rose/60 bg-brand-blush/30 p-4 sm:grid-cols-3">
          <div><p className="text-xs text-brand-dusty">Reserved stock</p><p className="mt-1 text-lg font-semibold">{products.find((product) => product.id === editingId)?.reservedStock ?? 0}</p></div>
          <div><p className="text-xs text-brand-dusty">Available stock</p><p className="mt-1 text-lg font-semibold">{products.find((product) => product.id === editingId)?.availableStock ?? 0}</p></div>
          <label className="text-sm font-medium">Add/remove stock<input className="input-field mt-1" type="number" step="1" value={form.stockAdjustment} onChange={(e) => setField('stockAdjustment', e.target.value)} placeholder="e.g. 5 or -2" /></label>
        </div>}
        {error && <p className="text-sm text-red-700">{error}</p>}{warning && <p className="text-sm text-amber-700">{warning}</p>}{status && <p className="text-sm text-emerald-700">{status}</p>}
        <div className="flex flex-wrap gap-3"><button className="btn-gold" type="submit" disabled={saving}>{saving ? 'Saving...' : editingId ? 'Update product' : 'Save product'}</button><button className="btn-outline" type="button" onClick={resetForm}>Cancel</button></div>
      </form>}
      {!isAddProduct && !editingId && <section className="space-y-4 rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft"><div className="grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_1fr]"><input className="input-field" placeholder="Search by product name or fabric" value={search} onChange={(e) => setSearch(e.target.value)} /><select className="input-field" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option value="all">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select><select className="input-field" value={availabilityFilter} onChange={(e) => setAvailabilityFilter(e.target.value)}><option value="all">All availability</option><option value="available">Available</option><option value="unavailable">Out of stock</option></select><select className="input-field" value={sort} onChange={(e) => setSort(e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></div><p className="text-sm text-brand-dusty">Showing {filteredProducts.length} of {products.length} products</p>{loadingProducts ? <p className="py-8 text-center text-sm text-brand-dusty">Loading products...</p> : !filteredProducts.length ? <p className="rounded-xl border border-dashed border-brand-pale-rose p-8 text-center text-sm text-brand-dusty">No products match these filters.</p> : <div className="grid gap-3">{filteredProducts.map((product) => <article key={product.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-brand-pale-rose/60 p-4"><div className="flex min-w-0 items-center gap-4"><img src={getPrimaryImageUrl(product.images, 'https://placehold.co/280x280/FFF8F7/92716C?text=GV')} alt={product.name} className="h-16 w-16 rounded-lg object-cover" /><div className="min-w-0"><p className="truncate font-medium">{product.name}</p><p className="truncate text-sm text-brand-dusty">{product.category} · {product.fabric} · {formatINR(product.price)}</p><p className="mt-1 text-xs text-brand-dusty">Physical {product.totalStock ?? 0} · Reserved {product.reservedStock ?? 0} · Available {product.availableStock ?? 0}</p><span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs ${(product.availableStock ?? 0) > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{(product.availableStock ?? 0) > 0 ? 'Available' : 'Out of stock'}</span></div></div><div className="flex gap-2"><button className="btn-outline px-4 py-2" type="button" onClick={() => handleEdit(product)}>Edit</button><button className="rounded-full border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50" type="button" onClick={() => handleDelete(product.id)}>Delete</button></div></article>)}</div>}</section>}
    </div>
  )
}
