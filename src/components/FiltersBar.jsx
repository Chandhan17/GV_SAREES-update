import { SlidersHorizontal } from 'lucide-react'
import { categories, fabricTypes, getFabricsForCategory } from '../config/categories'

export default function FiltersBar({ filters, onChange, onClear, onApply, layout = 'mobile', sizeOptions = [] }) {
  const availableFabrics = filters.category ? getFabricsForCategory(filters.category) : fabricTypes
  const isSidebar = layout === 'sidebar'

  return (
    <section className={`rounded-[1.5rem] border border-brand-pale-rose/10 bg-brand-card-white p-5 shadow-soft md:p-6 ${isSidebar ? 'md:rounded-2xl md:p-5' : ''}`}>
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={17} className="text-brand-rose-gold" />
          <p className="text-sm font-semibold text-brand-dusty">{isSidebar ? 'Filters' : 'Refine your search'}</p>
        </div>
      </div>

      <div className={isSidebar ? 'space-y-4' : 'grid gap-3 md:grid-cols-2 lg:grid-cols-4'}>
        <label className={`text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty ${isSidebar ? 'block' : 'lg:col-span-2'}`}>
          Search
          <input
            value={filters.search}
            onChange={(event) => onChange('search', event.target.value)}
            placeholder="Search by saree name"
            className="input-field mt-2 normal-case tracking-normal"
          />
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty">
          Category
          <select value={filters.category} onChange={(event) => onChange('category', event.target.value)} className="input-field mt-2 normal-case tracking-normal">
            <option value="">All categories</option>
            {categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>

        <div className={isSidebar ? 'space-y-4' : 'mt-3 grid gap-3 sm:col-span-2 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-5'}>
          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty">
            Fabric
            <select value={filters.fabric} onChange={(event) => onChange('fabric', event.target.value)} className="input-field mt-2 normal-case tracking-normal">
              <option value="">All fabrics</option>
              {availableFabrics.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty">
            Size / length
            <select value={filters.sizeLength} onChange={(event) => onChange('sizeLength', event.target.value)} className="input-field mt-2 normal-case tracking-normal">
              <option value="">All sizes</option>
              {sizeOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty">
            Min price
            <input value={filters.minPrice} onChange={(event) => onChange('minPrice', event.target.value)} type="number" min="0" className="input-field mt-2 normal-case tracking-normal" placeholder="₹ 0" />
          </label>

          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-dusty">
            Max price
            <input value={filters.maxPrice} onChange={(event) => onChange('maxPrice', event.target.value)} type="number" min="0" className="input-field mt-2 normal-case tracking-normal" placeholder="₹ 50,000" />
          </label>

          <label className="flex items-end gap-3 rounded-xl border border-brand-pale-rose/10 px-4 py-3 text-sm text-brand-dusty">
            <input
              type="checkbox"
              checked={filters.onlyAvailable}
              onChange={(event) => onChange('onlyAvailable', event.target.checked)}
              className="mb-0.5 h-4 w-4 accent-brand-dusty"
            />
            <span>In stock only</span>
          </label>
        </div>
      </div>

      <div className="mt-5 flex gap-3 border-t border-brand-pale-rose/10 pt-5">
        <button type="button" onClick={onClear} className="btn-outline flex-1">Clear</button>
        <button type="button" onClick={onApply} className="btn-gold flex-1">Apply</button>
      </div>
    </section>
  )
}
