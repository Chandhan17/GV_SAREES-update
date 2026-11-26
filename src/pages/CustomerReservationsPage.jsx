import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getCustomerReservationStatus, getCustomerReservations } from '../services/reservationService'
import { formatStoreDateTime } from '../utils/orderDate'

const STATUS_LABELS = {
  pending: 'Payment pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  completed: 'Delivered',
  cancelled: 'Cancelled',
  expired: 'Expired',
  not_found: 'Reservation unavailable',
  unavailable: 'Status unavailable',
}

const PAYMENT_STATUS_LABELS = {
  pending: 'Payment status being verified',
  authorized: 'Authorized · awaiting capture',
  captured: 'Paid',
  failed: 'Payment failed',
}

function getStatusMessage(reservation) {
  if (reservation.status === 'confirmed') {
    return 'Payment was verified and this order was confirmed automatically.'
  }
  if (reservation.status === 'delivered' || reservation.status === 'completed') return 'This order has been delivered.'
  if (reservation.status === 'cancelled') return 'This order is cancelled.'
  if (reservation.status === 'expired') {
    return reservation.paymentStatus === 'captured'
      ? 'Payment was captured after stock was released. The store is checking fulfillment or refund status.'
      : 'This checkout hold expired. No order was confirmed.'
  }
  if (reservation.status === 'not_found') return 'The order record could not be found. Contact the store if you need help.'
  if (reservation.status === 'unavailable' && !reservation.statusError) {
    return 'The current reservation status is unavailable. Please contact the store for help.'
  }
  if (reservation.paymentMethod === 'razorpay' && reservation.paymentStatus === 'pending') {
    return reservation.inventoryStatus === 'released_pending_verification'
      ? 'Payment is still being verified. The stock hold was released; if payment is captured later, the store will check inventory and resolve or refund it.'
      : 'Razorpay has not confirmed the payment outcome. Reserved stock remains held while payment is reconciled.'
  }
  if (reservation.paymentMethod === 'razorpay' && reservation.paymentStatus === 'authorized') {
    return reservation.inventoryStatus === 'released_pending_verification'
      ? 'Razorpay authorized the payment, but its final outcome is still being verified. The stock hold was released; a later capture will require an inventory check.'
      : 'Razorpay authorized this payment but has not confirmed its final outcome. Reserved stock remains held while payment is reconciled.'
  }
  if (reservation.paymentMethod === 'razorpay' && reservation.paymentStatus === 'failed') {
    return reservation.inventoryStatus === 'held'
      ? 'Razorpay confirmed the failed attempt; the stock release is being reconciled.'
      : 'Razorpay confirmed that payment failed and the stock hold was released.'
  }
  if (reservation.paymentReconciliationStatus === 'manual_review') {
    return 'Payment was captured after the reservation released its stock. The store is checking fulfillment availability and may need to resolve or refund the payment.'
  }
  return ''
}

function getStatusStyle(status) {
  if (['confirmed', 'processing', 'shipped', 'delivered', 'completed'].includes(status)) return 'bg-emerald-50 text-emerald-800'
  if (status === 'cancelled') return 'bg-slate-100 text-slate-700'
  if (status === 'expired') return 'bg-amber-50 text-amber-800'
  return 'bg-brand-blush text-brand-burgundy'
}

export default function CustomerReservationsPage() {
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingError, setLoadingError] = useState('')
  const [error, setError] = useState('')
  const refreshInProgressRef = useRef(false)
  const hasLoadedRef = useRef(false)
  const mountedRef = useRef(false)

  const refreshReservations = useCallback(async () => {
    if (refreshInProgressRef.current) return
    refreshInProgressRef.current = true
    if (!hasLoadedRef.current) setLoading(true)

    try {
      const savedReservations = getCustomerReservations()
      if (!mountedRef.current) return
      setLoadingError('')

      const refreshed = await Promise.all(savedReservations.map(async (reservation) => {
        if (!reservation.accessAvailable) {
          return {
            ...reservation,
            status: 'unavailable',
            statusError: 'Reservation access details are unavailable on this device.',
          }
        }

        try {
          const current = await getCustomerReservationStatus(reservation.reservationId)
          return { ...reservation, ...current, statusError: '' }
        } catch (statusError) {
          return {
            ...reservation,
            status: statusError?.status === 404 ? 'not_found' : 'unavailable',
            statusError: statusError?.message || 'Unable to refresh reservation status. Please try again.',
          }
        }
      }))

      if (mountedRef.current) {
        setReservations(refreshed)
        if (refreshed.some((reservation) => !reservation.statusError)) setError('')
      }
    } catch (refreshError) {
      if (mountedRef.current) {
        setLoadingError(refreshError?.message || 'Unable to read saved reservation details.')
      }
    } finally {
      refreshInProgressRef.current = false
      hasLoadedRef.current = true
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refreshReservations()

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshReservations()
    }
    const intervalId = window.setInterval(refreshReservations, 12_000)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      mountedRef.current = false
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refreshReservations])

  return (
    <section className="mx-auto min-h-[55vh] max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-dusty">Your account</p>
        <h1 className="mt-2 font-display text-4xl text-brand-burgundy">My Orders</h1>
        <p className="mt-3 max-w-2xl text-sm text-brand-dusty">
          Orders saved on this browser appear here. Payment and fulfillment status is refreshed securely from the store.
        </p>
      </header>

      {error && <p className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-800" role="alert">{error}</p>}
      {loadingError && <p className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-800" role="alert">{loadingError}</p>}

      {loading ? (
        <p className="py-8 text-center text-sm text-brand-dusty">Loading order statuses...</p>
      ) : !loadingError && reservations.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-pale-rose p-8 text-center">
          <p className="text-brand-dusty">No orders are saved on this browser.</p>
          <Link className="btn-gold mt-5 inline-flex px-6 py-3" to="/products">Browse products</Link>
        </div>
      ) : (
        <div className="space-y-4">
          {reservations.map((reservation) => {
            const statusMessage = getStatusMessage(reservation)
            return (
              <article key={reservation.reservationId} className="rounded-2xl border border-brand-pale-rose/70 bg-brand-card-white p-5 shadow-soft">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <h2 className="font-semibold text-brand-burgundy">Order products</h2>
                    <p className="mt-1 text-sm text-brand-dusty">
                      Order ID: <span className="break-all">{reservation.orderId || reservation.reservationId}</span>
                    </p>
                    <p className="mt-1 text-sm text-brand-dusty">
                      Order placed: {formatStoreDateTime(reservation.createdAt)}
                    </p>
                    {(reservation.items?.length ? reservation.items : [{
                      productName: reservation.productName || 'Product order',
                      quantity: reservation.reservedQuantity,
                      price: reservation.price,
                    }]).map((item, index) => (
                      <p key={`${item.productId || item.productName}-${index}`} className="mt-1 text-sm text-brand-dusty">
                        {item.productName || item.name || 'Product'} · Size: {item.selectedSize || '--'} · Qty: {item.quantity ?? '--'} · Unit: ₹{item.price ?? item.unitPrice ?? '--'} · Line total: ₹{item.lineSubtotal ?? Number(item.price ?? item.unitPrice ?? 0) * Number(item.quantity ?? 0)}
                      </p>
                    ))}
                    {(Number.isFinite(reservation.totalAmount) || Number.isFinite(reservation.paymentAmountPaise)) && (
                      <p className="mt-2 text-sm font-semibold text-brand-burgundy">
                        Order total: ₹{Number.isFinite(reservation.paymentAmountPaise) ? reservation.paymentAmountPaise / 100 : reservation.totalAmount}
                      </p>
                    )}
                    {reservation.expiresAt && (
                      reservation.status === 'pending' && <p className="mt-1 text-sm text-brand-dusty">Checkout hold until {new Date(reservation.expiresAt).toLocaleString('en-IN')}</p>
                    )}
                    {reservation.paymentMethod === 'razorpay' && (
                      <p className="mt-2 text-sm font-medium text-brand-burgundy" role="status">
                        {PAYMENT_STATUS_LABELS[reservation.paymentStatus] || 'Payment status unavailable'}
                      </p>
                    )}
                    {reservation.paymentId && <p className="mt-1 text-xs text-brand-dusty">Razorpay payment ID: {reservation.paymentId}</p>}
                    {reservation.orderStatus && <p className="mt-1 text-sm text-brand-dusty">Fulfillment: {reservation.orderStatus}</p>}
                    {statusMessage && <p className="mt-2 text-sm text-brand-dusty">{statusMessage}</p>}
                    {reservation.statusError && reservation.status !== 'not_found' && (
                      <p className="mt-2 text-sm text-amber-800" role="status">
                        Status could not be refreshed. Please try again; it may be out of date.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
                    <span className={`rounded-full px-4 py-2 text-sm font-medium ${getStatusStyle(reservation.status)}`}>
                      {STATUS_LABELS[reservation.status] || STATUS_LABELS.unavailable}
                    </span>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
