import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'
import { archiveOrder, subscribeOrders, updateOrder } from '../services/orderService'
import { formatINR } from '../utils/formatters'
import { useToast } from '../hooks/useToast'
import { adminReservationAction } from '../services/reservationService'

function formatDate(value) {
  if (!value) return '--'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleDateString('en-IN')
}

function paymentBadgeClass(status) {
  if (status === 'paid') return 'bg-emerald-100 text-emerald-700'
  return 'bg-amber-100 text-amber-700'
}

const ORDER_STATUS_OPTIONS = ['initiated', 'confirmed', 'completed']

export default function AdminOrders() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all')
  const [orderStatusFilter, setOrderStatusFilter] = useState('all')
  const [sortOrder, setSortOrder] = useState('newest')
  const [selectedOrderIds, setSelectedOrderIds] = useState([])
  const [bulkStatus, setBulkStatus] = useState('')
  const [viewingOrder, setViewingOrder] = useState(null)
  const [updatingOrderId, setUpdatingOrderId] = useState('')
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [deletingOrderId, setDeletingOrderId] = useState('')
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const { error, success } = useToast()

  useEffect(() => {
    const unsubscribe = subscribeOrders(
      (nextOrders) => {
        setOrders(nextOrders)
        setLoading(false)
      },
      (err) => {
        setLoading(false)
        error(err?.message || 'Failed to load orders.')
      },
    )

    return unsubscribe
  }, [error])

  useEffect(() => {
    const expired = orders.filter((order) =>
      order.reservationStatus === 'active' &&
      order.expiresAt instanceof Date &&
      order.expiresAt.getTime() <= Date.now()
    )
    expired.forEach((order) => {
      adminReservationAction({ action: 'expire', reservationId: order.reservationId }).catch((err) => {
        error(err?.message || 'Unable to release an expired reservation.')
      })
    })
  }, [orders, error])

  const filteredOrders = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()

    return [...orders].filter((order) => !order.archived).filter((order) => {
      const paymentMatch = paymentStatusFilter === 'all' || order.paymentStatus === paymentStatusFilter
      const orderMatch = orderStatusFilter === 'all' || order.orderStatus === orderStatusFilter

      if (!term) return paymentMatch && orderMatch

      const haystack = [
        order.productName,
        order.customer?.name,
        order.customer?.phone,
        order.customer?.address,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return paymentMatch && orderMatch && haystack.includes(term)
    }).sort((a, b) => {
      const first = a.createdAt?.getTime?.() || 0
      const second = b.createdAt?.getTime?.() || 0
      return sortOrder === 'oldest' ? first - second : second - first
    })
  }, [orders, searchTerm, paymentStatusFilter, orderStatusFilter, sortOrder])

  const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every((order) => selectedOrderIds.includes(order.id))
  const selectedCount = selectedOrderIds.length

  const toggleRow = (orderId) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId],
    )
  }

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedOrderIds((prev) => prev.filter((id) => !filteredOrders.some((order) => order.id === id)))
      return
    }

    const filteredIds = filteredOrders.map((order) => order.id)
    setSelectedOrderIds((prev) => Array.from(new Set([...prev, ...filteredIds])))
  }

  const handleOrderStatusUpdate = async (orderId, orderStatus) => {
    const order = orders.find((item) => item.id === orderId)
    if (order?.reservationId && orderStatus === 'confirmed') {
      try {
        setUpdatingOrderId(orderId)
        await adminReservationAction({ action: 'confirm', reservationId: order.reservationId })
        success('Reservation confirmed and stock deducted.')
      } catch (err) {
        error(err?.message || 'Unable to confirm reservation.')
      } finally {
        setUpdatingOrderId('')
      }
      return
    }
    try {
      setUpdatingOrderId(orderId)
      await updateOrder(orderId, { orderStatus })
      success(`Order marked as ${orderStatus}.`)
    } catch (err) {
      error(err?.message || 'Unable to update order status.')
    } finally {
      setUpdatingOrderId('')
    }
  }

  const handleBulkApplyStatus = async () => {
    if (!bulkStatus || !selectedCount) {
      error('Select orders and status before applying bulk update.')
      return
    }

    try {
      setBulkUpdating(true)
      const results = await Promise.allSettled(selectedOrderIds.map(async (orderId) => {
        await updateOrder(orderId, { orderStatus: bulkStatus })
      }))
      const succeeded = results.filter((result) => result.status === 'fulfilled').length
      const failed = results.length - succeeded
      if (succeeded) success(`Updated ${succeeded} order(s) to ${bulkStatus}${failed ? `; ${failed} rejected` : ''}.`)
      if (failed) error(`${failed} order(s) were not updated. Check reservation status and try again.`)
      setSelectedOrderIds([])
      setBulkStatus('')
    } catch (err) {
      error(err?.message || 'Unable to apply bulk status update.')
    } finally {
      setBulkUpdating(false)
    }
  }

  const handleDeleteOrder = async (orderId) => {
    const order = orders.find((item) => item.id === orderId)
    if (order?.reservationStatus === 'active') {
      error('This order has an active reservation. Release or resolve it before archiving.')
      return
    }
    if (!window.confirm('Archive this enquiry? The order record will be preserved.')) return
    try {
      setDeletingOrderId(orderId)
      await archiveOrder(orderId)
      setSelectedOrderIds((prev) => prev.filter((id) => id !== orderId))
      success('Order archived. History was preserved.')
    } catch (err) {
      error(err?.message || 'Unable to delete order.')
    } finally {
      setDeletingOrderId('')
    }
  }

  const handleBulkDelete = async () => {
    if (!selectedCount) {
      error('Select at least one order to delete.')
      return
    }

    try {
      setBulkDeleting(true)
      const activeSelected = selectedOrderIds.filter((id) => orders.find((item) => item.id === id)?.reservationStatus === 'active')
      if (activeSelected.length) {
        error(`${activeSelected.length} selected order(s) have active reservations. Release or resolve them before archiving.`)
        return
      }
      const results = await Promise.allSettled(selectedOrderIds.map((orderId) => archiveOrder(orderId)))
      const succeeded = results.filter((result) => result.status === 'fulfilled').length
      const failed = results.length - succeeded
      if (succeeded) success(`Archived ${succeeded} order(s); history was preserved.`)
      if (failed) error(`${failed} order(s) could not be archived.`)
      setSelectedOrderIds([])
    } catch (err) {
      error(err?.message || 'Unable to delete selected orders.')
    } finally {
      setBulkDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="section-kicker">Admin Panel</p>
          <h1 className="section-title">Manage Orders</h1>
        </div>
        <Link to="/admin" className="btn-outline">Back to overview</Link>
      </div>

      <section className="space-y-4 rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-5 shadow-soft">
        <h2 className="text-2xl font-semibold text-brand-dusty">Filters</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm text-brand-dusty">
            Search
            <input
              className="input-field mt-1"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Name, phone, or product..."
            />
          </label>

          <label className="text-sm text-brand-dusty">
            Sort
            <select className="input-field mt-1" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>

          <label className="text-sm text-brand-dusty">
            Payment Status
            <select
              className="input-field mt-1"
              value={paymentStatusFilter}
              onChange={(event) => setPaymentStatusFilter(event.target.value)}
            >
              <option value="all">All Payment Statuses</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
            </select>
          </label>

          <label className="text-sm text-brand-dusty">
            Order Status
            <select
              className="input-field mt-1"
              value={orderStatusFilter}
              onChange={(event) => setOrderStatusFilter(event.target.value)}
            >
              <option value="all">All Order Statuses</option>
              {ORDER_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <p className="text-sm text-brand-dusty">Showing {filteredOrders.length} of {orders.length} orders</p>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-rose-gold/25 bg-brand-card-white p-4 shadow-soft">
        <p className="text-sm text-brand-dusty">Selected: {selectedCount}</p>

        <div className="flex flex-wrap items-center gap-2">
          <select className="input-field w-56" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}>
            <option value="">Update selected status...</option>
            {ORDER_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="rounded-lg bg-brand-rose-gold px-4 py-2 text-sm font-medium text-brand-button-text disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleBulkApplyStatus}
            disabled={!selectedCount || !bulkStatus || bulkUpdating || bulkDeleting}
          >
            {bulkUpdating ? 'Applying...' : 'Apply'}
          </button>

          <button
            type="button"
            className="rounded-lg border border-brand-pale-rose/40 bg-brand-card-white px-4 py-2 text-sm font-medium text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleBulkDelete}
            disabled={!selectedCount || bulkDeleting || bulkUpdating}
          >
            {bulkDeleting ? 'Archiving...' : 'Archive Selected'}
          </button>

          <button
            type="button"
            className="rounded-lg border border-brand-pale-rose/20 bg-brand-card-white px-4 py-2 text-sm font-medium text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setSelectedOrderIds([])
              setBulkStatus('')
            }}
            disabled={!selectedCount && !bulkStatus}
          >
            Clear
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-brand-rose-gold/25 bg-brand-card-white shadow-soft">
        {loading ? (
          <p className="p-5 text-brand-dusty">Loading orders...</p>
        ) : !filteredOrders.length ? (
          <p className="p-5 text-brand-dusty">No orders found for selected filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="border-b border-brand-rose-gold/20 bg-brand-card-white text-sm text-brand-dusty">
                <tr>
                  <th className="px-4 py-3">
                    <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAllFiltered} aria-label="Select all filtered orders" />
                  </th>
                  <th className="px-4 py-3">Customer / Product</th>
                  <th className="px-4 py-3">Price / Size</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3">Order Status</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredOrders.map((order) => {
                  const isSelected = selectedOrderIds.includes(order.id)
                  const isUpdating = updatingOrderId === order.id
                  const isDeleting = deletingOrderId === order.id

                  return (
                    <tr key={order.id} className="border-b border-brand-rose-gold/15 align-top text-sm text-brand-dusty last:border-b-0">
                      <td className="px-4 py-4">
                        <input type="checkbox" checked={isSelected} onChange={() => toggleRow(order.id)} aria-label={`Select order ${order.id}`} />
                      </td>

                      <td className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <img
                            src={order.image || 'https://placehold.co/96x96/FFF8F7/92716C?text=Order'}
                            alt={order.productName || 'Order product'}
                            className="h-14 w-14 rounded-lg border border-brand-rose-gold/20 bg-brand-card-white object-cover"
                            loading="lazy"
                          />
                          <div>
                            <p className="font-semibold text-brand-dusty">{order.customer?.name || '--'}</p>
                            <p className="text-brand-dusty">{order.productName || '--'}</p>
                            <p className="text-brand-dusty">{order.customer?.phone || '--'}</p>
                            <p className="max-w-xs text-brand-dusty">{order.customer?.address || '--'}</p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-4">
                        <p className="font-semibold text-brand-dusty">{formatINR(order.price || 0)}</p>
                        <p className="text-brand-dusty">Size: {order.selectedSize || '--'}</p>
                      </td>

                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${paymentBadgeClass(order.paymentStatus)}`}>
                          {order.paymentStatus || 'pending'}
                        </span>
                        <p className="mt-1 text-brand-dusty">{order.paymentMethod || '--'}</p>
                        {order.razorpayPaymentId && <p className="truncate text-xs text-brand-dusty">ID: {order.razorpayPaymentId}</p>}
                      </td>

                      <td className="px-4 py-4">
                        <select
                          className="input-field min-w-40"
                          value={order.orderStatus || 'initiated'}
                          onChange={(event) => handleOrderStatusUpdate(order.id, event.target.value)}
                          disabled={isUpdating}
                        >
                          {ORDER_STATUS_OPTIONS.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-4 py-4 text-brand-dusty">{formatDate(order.createdAt)}</td>

                      <td className="px-4 py-4">
                        <div className="flex gap-2">
                          <button type="button" className="rounded-lg border border-brand-pale-rose/20 bg-brand-card-white px-3 py-1.5 text-sm text-brand-dusty" onClick={() => setViewingOrder(order)}>
                            View
                          </button>
                          {order.reservationId && order.reservationStatus === 'active' && (
                            <button
                              type="button"
                              className="rounded-lg border border-amber-200 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50"
                              onClick={async () => {
                                if (!window.confirm('Release this reservation and make the stock available again?')) return
                                try {
                                  await adminReservationAction({ action: 'release', reservationId: order.reservationId })
                                  success('Reservation released.')
                                } catch (err) {
                                  error(err?.message || 'Unable to release reservation.')
                                }
                              }}
                            >
                              Release
                            </button>
                          )}
                          {order.reservationId && order.reservationStatus === 'converted' && (
                            <button
                              type="button"
                              className="rounded-lg border border-brand-pale-rose/40 px-3 py-1.5 text-sm text-brand-dusty hover:bg-brand-blush"
                              onClick={async () => {
                                if (!window.confirm('Explicitly restore physical stock for this cancelled/refunded order?')) return
                                try {
                                  await adminReservationAction({ action: 'restock-cancelled', reservationId: order.reservationId, reason: 'Admin restocked cancelled/refunded goods' })
                                  success('Physical stock restored once.')
                                } catch (err) {
                                  error(err?.message || 'Unable to restock order.')
                                }
                              }}
                            >
                              Restock
                            </button>
                          )}
                          {order.customer?.phone && (
                            <a
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50"
                              href={`https://wa.me/${String(order.customer.phone).replace(/\D/g, '')}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Contact ${order.customer.name || 'customer'} on WhatsApp`}
                            >
                              <MessageCircle className="h-4 w-4" />
                              WhatsApp
                            </a>
                          )}
                          <button
                            type="button"
                            className="rounded-lg border border-brand-pale-rose/40 bg-brand-card-white px-3 py-1.5 text-sm text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => handleDeleteOrder(order.id)}
                            disabled={isDeleting}
                          >
                            {isDeleting ? 'Archiving...' : 'Archive'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {viewingOrder && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-xl rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-royal">
            <h3 className="font-display text-2xl text-brand-dusty">Order Details</h3>

            <div className="mt-4 grid gap-4 sm:grid-cols-[120px_1fr]">
              <img
                src={viewingOrder.image || 'https://placehold.co/120x120/FFF8F7/92716C?text=Order'}
                alt={viewingOrder.productName || 'Order product'}
                className="h-28 w-28 rounded-lg border border-brand-rose-gold/20 bg-brand-card-white object-cover"
                loading="lazy"
              />

              <div className="space-y-1 text-sm text-brand-dusty">
                <p><span className="font-medium">Product:</span> {viewingOrder.productName || '--'}</p>
                <p><span className="font-medium">Price:</span> {formatINR(viewingOrder.price || 0)}</p>
                <p><span className="font-medium">Size:</span> {viewingOrder.selectedSize || '--'}</p>
                <p><span className="font-medium">Customer:</span> {viewingOrder.customer?.name || '--'}</p>
                <p><span className="font-medium">Phone:</span> {viewingOrder.customer?.phone || '--'}</p>
                <p><span className="font-medium">Address:</span> {viewingOrder.customer?.address || '--'}</p>
                <p><span className="font-medium">Payment:</span> {viewingOrder.paymentMethod || '--'} / {viewingOrder.paymentStatus || '--'}</p>
                <p><span className="font-medium">Order Status:</span> {viewingOrder.orderStatus || '--'}</p>
                <p><span className="font-medium">Date:</span> {formatDate(viewingOrder.createdAt)}</p>
              </div>
            </div>

            <div className="mt-5 text-right">
              <button type="button" className="btn-outline" onClick={() => setViewingOrder(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
