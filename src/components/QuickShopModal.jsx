import { useMemo, useState } from 'react'
import clientConfig from '../config/clientConfig'
import { createWhatsAppReservation, rememberCustomerReservation } from '../services/reservationService'
import { openWhatsApp } from '../services/whatsappService'
import { useToast } from '../hooks/useToast'

const STORAGE_KEY = 'saree_store_customer_details'
const defaultCustomer = { name: '', phone: '', doorNo: '', streetName: '', city: '', pincode: '', state: '' }

function normalizeCustomer(raw) {
  if (!raw || typeof raw !== 'object') return defaultCustomer
  return { ...defaultCustomer, ...raw, streetName: raw.streetName || raw.address || '' }
}

export default function QuickShopModal({ product, isOpen, onClose }) {
  const [customer, setCustomer] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaultCustomer
    try { return normalizeCustomer(JSON.parse(stored)) } catch { return defaultCustomer }
  })
  const [validationError, setValidationError] = useState('')
  const [submittingWhatsApp, setSubmittingWhatsApp] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const { error, success } = useToast()

  const addressText = useMemo(
    () => [customer.doorNo, customer.streetName, customer.city, customer.pincode, customer.state].filter((value) => String(value || '').trim()).join(', '),
    [customer],
  )
  const availableStock = Number.isInteger(product?.availableStock) ? product.availableStock : 0
  const outOfStock = availableStock <= 0
  const isFormValid = Object.values(customer).every((value) => String(value).trim())

  const handleFieldChange = (field, value) => {
    setIdempotencyKey(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    setValidationError('')
    setCustomer((previous) => ({ ...previous, [field]: value }))
  }

  const handleEnquire = async () => {
    if (outOfStock) return error('This product is currently out of stock.')
    if (quantity > availableStock) return setValidationError(`Only ${availableStock} item(s) are currently available.`)
    if (!isFormValid) {
      setValidationError('Please fill all fields before sending enquiry.')
      return error('Please fill all fields before sending enquiry.')
    }

    try {
      setSubmittingWhatsApp(true)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customer))
      const reservation = await createWhatsAppReservation({
        productId: product.id,
        quantity,
        idempotencyKey,
        selectedSize: product.sizeLength || '',
        customer: { name: customer.name, phone: customer.phone, address: addressText },
      })
      try {
        rememberCustomerReservation(reservation)
      } catch {
        error('Stock was reserved, but cancellation details could not be saved on this device.')
      }
      const expiry = reservation.expiresAt
        ? new Date(reservation.expiresAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
        : '30 minutes'
      const productUrl = `${window.location.origin}/products/${product.id}`
      const message = `View product: ${productUrl}

Hi, I want to order:

Product: ${reservation.productName}
Quantity: ${quantity}
Price: ₹${reservation.price}
Reservation: Pending - reserved until ${expiry}

Customer Details:
Name: ${customer.name}
Phone: ${customer.phone}
Address: ${addressText}`
      success(`Stock reserved until ${expiry}. Opening WhatsApp...`)
      await openWhatsApp(String(clientConfig.whatsapp || '').replace(/\D/g, ''), message)
      setIdempotencyKey(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      onClose()
    } catch (err) {
      error(err?.message || 'Unable to reserve stock.')
    } finally {
      setSubmittingWhatsApp(false)
    }
  }

  if (!isOpen || !product) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-royal">
        <h3 className="font-display text-3xl text-brand-dusty">Enquire on WhatsApp</h3>
        <p className="mt-1 text-sm text-brand-dusty">Product: {product.name}</p>
        {!outOfStock && <p className="mt-1 text-sm text-brand-dusty">{availableStock} available · held for 30 minutes after submission</p>}
        {outOfStock && <p className="mt-3 font-semibold text-brand-dusty">This product is currently out of stock.</p>}

        <div className="mt-5 space-y-3">
          {[
            ['name', 'Name'],
            ['phone', 'Phone'],
            ['doorNo', 'Door No'],
            ['streetName', 'Street Name'],
          ].map(([field, placeholder]) => (
            <input key={field} className="input-field" placeholder={placeholder} value={customer[field]} onChange={(event) => handleFieldChange(field, event.target.value)} required disabled={outOfStock} />
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <input className="input-field" placeholder="City" value={customer.city} onChange={(event) => handleFieldChange('city', event.target.value)} required disabled={outOfStock} />
            <input className="input-field" placeholder="Pincode" value={customer.pincode} onChange={(event) => handleFieldChange('pincode', event.target.value)} required disabled={outOfStock} />
          </div>
          <input className="input-field" placeholder="State" value={customer.state} onChange={(event) => handleFieldChange('state', event.target.value)} required disabled={outOfStock} />
          {!outOfStock && <label className="block text-sm text-brand-dusty">Quantity<input className="input-field mt-1" type="number" min="1" max={availableStock} value={quantity} onChange={(event) => { setIdempotencyKey(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`); setQuantity(Math.max(1, Math.min(availableStock, Number(event.target.value) || 1))) }} disabled={submittingWhatsApp} /></label>}
        </div>
        {validationError && <p className="mt-3 text-sm text-brand-dusty">{validationError}</p>}
        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-outline flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className={`flex-1 ${outOfStock ? 'cursor-not-allowed bg-brand-dusty' : 'btn-gold'} disabled:cursor-not-allowed disabled:opacity-60`} onClick={handleEnquire} disabled={!isFormValid || submittingWhatsApp || outOfStock}>
            {outOfStock ? 'Out of Stock' : submittingWhatsApp ? 'Reserving...' : 'Reserve & enquire'}
          </button>
        </div>
      </div>
    </div>
  )
}
