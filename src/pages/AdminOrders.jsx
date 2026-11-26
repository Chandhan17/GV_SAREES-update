import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteOrders, permanentlyDeleteOrders, subscribeOrders, updateOrder } from '../services/orderService'
import { formatINR } from '../utils/formatters'
import { useToast } from '../hooks/useToast'
import { adminReservationAction } from '../services/reservationService'
import { getOrderItems, getOrderReservedQuantity, getOrderTotal } from '../utils/orderPresentation'
import { formatStoreDateTime, getOrderDate, isOrderWithinDateRange, validateOrderDateRange } from '../utils/orderDate'
import {
  applyReservationRestock,
  getDisplayedOrderStatus,
} from '../utils/reservationOrderState'

function formatDate(value) {
  return formatStoreDateTime(value)
}

function paymentBadgeClass(status) {
  if (status === 'paid' || status === 'refunded') return 'bg-emerald-100 text-emerald-700'
  return 'bg-amber-100 text-amber-700'
}

function getDisplayedPaymentStatus(order) {
  if (order.refundStatus === 'processed' || order.paymentStatus === 'refunded') return 'refunded'
  if (['captured', 'paid'].includes(order.paymentStatus)) return 'paid'
  if (['pending', 'authorized'].includes(order.paymentStatus)) return 'pending'
  return order.paymentStatus || 'pending'
}

const ORDER_STATUS_FILTER_OPTIONS = ['initiated', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'completed']
const ORDER_STATUS_OPTIONS = ['processing', 'shipped', 'delivered', 'cancelled']

function getAllowedOrderStatusOptions(order) {
  const current = getDisplayedOrderStatus(order)
  const transitions = {
    initiated: ['cancelled'],
    confirmed: ['processing', 'cancelled'],
    processing: ['shipped', 'cancelled'],
    shipped: ['delivered', 'cancelled'],
  }
  return [current, ...(transitions[current] || [])]
}

export default function AdminOrders() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all')
  const [orderStatusFilter, setOrderStatusFilter] = useState('all')
  const [startDateDraft, setStartDateDraft] = useState('')
  const [endDateDraft, setEndDateDraft] = useState('')
  const [appliedStartDate, setAppliedStartDate] = useState('')
  const [appliedEndDate, setAppliedEndDate] = useState('')
  const [dateRangeError, setDateRangeError] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [sortOrder, setSortOrder] = useState('newest')
  const [selectedOrderIds, setSelectedOrderIds] = useState([])
  const [bulkStatus, setBulkStatus] = useState('')
  const [viewingOrder, setViewingOrder] = useState(null)
  const [updatingOrderId, setUpdatingOrderId] = useState('')
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [deletingOrderId, setDeletingOrderId] = useState('')
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [deletionDialog, setDeletionDialog] = useState(null)
  const [permanentDeletionDialog, setPermanentDeletionDialog] = useState(null)
  const [permanentDeleting, setPermanentDeleting] = useState(false)
  const [permanentBackupExporting, setPermanentBackupExporting] = useState(false)
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

    return [...orders].filter((order) => includeArchived || !order.archived).filter((order) => {
      const paymentMatch = paymentStatusFilter === 'all' || getDisplayedPaymentStatus(order) === paymentStatusFilter
      const orderMatch = orderStatusFilter === 'all' || order.orderStatus === orderStatusFilter
      const dateMatch = isOrderWithinDateRange(order.createdAt, appliedStartDate, appliedEndDate)
      const orderItems = getOrderItems(order)

      if (!term) return paymentMatch && orderMatch && dateMatch

      const haystack = [
        order.productName,
        ...orderItems.map((item) => item.productName),
        order.customer?.name,
        order.customer?.phone,
        order.customer?.address,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return paymentMatch && orderMatch && dateMatch && haystack.includes(term)
    }).sort((a, b) => {
      const first = getOrderDate(a.createdAt)?.getTime() || 0
      const second = getOrderDate(b.createdAt)?.getTime() || 0
      return sortOrder === 'oldest' ? first - second : second - first
    })
  }, [orders, searchTerm, paymentStatusFilter, orderStatusFilter, sortOrder, includeArchived, appliedStartDate, appliedEndDate])

  const selectableFilteredOrders = filteredOrders.filter((order) => !order.deletedAt && !order.deleted)
  const filteredOrderIds = new Set(selectableFilteredOrders.map((order) => order.id))
  const visibleSelectedOrderIds = selectedOrderIds.filter((id) => filteredOrderIds.has(id))
  const allFilteredSelected = selectableFilteredOrders.length > 0
    && selectableFilteredOrders.every((order) => visibleSelectedOrderIds.includes(order.id))
  const selectedCount = visibleSelectedOrderIds.length

  const toggleRow = (orderId) => {
    setSelectedOrderIds((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev.filter((id) => filteredOrderIds.has(id)), orderId],
    )
  }

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedOrderIds((prev) => prev.filter((id) => !filteredOrders.some((order) => order.id === id)))
      return
    }

    setSelectedOrderIds((prev) => Array.from(new Set([...prev.filter((id) => filteredOrderIds.has(id)), ...filteredOrderIds])))
  }

  const handleOrderStatusUpdate = async (orderId, orderStatus) => {
    try {
      setUpdatingOrderId(orderId)
      const result = await updateOrder(orderId, { orderStatus })
      if (result.success !== true || result.orderId !== orderId || result.orderStatus !== orderStatus) {
        throw new Error('Order status update succeeded, but the persisted status was not returned.')
      }
      setOrders((currentOrders) => currentOrders.map((currentOrder) => currentOrder.id === orderId
        ? { ...currentOrder, orderStatus: result.orderStatus }
        : currentOrder))
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
      const results = await Promise.allSettled(visibleSelectedOrderIds.map(async (orderId) => {
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

  const requestOrderDeletion = (orderIds) => {
    if (!orderIds.length || bulkDeleting || permanentDeleting || exporting || bulkUpdating || updatingOrderId) return
    setDeletionDialog({ orderIds: [...orderIds] })
  }

  const requestPermanentOrderDeletion = (orderIds) => {
    if (!orderIds.length || bulkDeleting || permanentDeleting || exporting || bulkUpdating || updatingOrderId) return
    setPermanentDeletionDialog({
      orderIds: [...orderIds],
      backupDisposition: '',
      results: [],
      permanentlyDeletedCount: 0,
      alreadyDeletedCount: 0,
    })
  }

  const exportOrdersToExcel = async (ordersToExport) => {
    const { createOrdersFilename, createOrdersWorkbook } = await import('../utils/orderExport.js')
    const buffer = await createOrdersWorkbook(ordersToExport, {
      startDate: appliedStartDate,
      endDate: appliedEndDate,
    })
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = createOrdersFilename(appliedStartDate, appliedEndDate)
    try {
      document.body.appendChild(link)
      link.click()
    } finally {
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    }
  }

  const handlePermanentDeletionBackup = async () => {
    if (!permanentDeletionDialog || permanentBackupExporting || permanentDeleting) return
    const selectedOrders = permanentDeletionDialog.orderIds
      .map((orderId) => orders.find((order) => order.id === orderId))
      .filter(Boolean)
    if (selectedOrders.length !== permanentDeletionDialog.orderIds.length) {
      error('One or more selected orders are no longer available for backup. Refresh the orders list and try again.')
      return
    }

    try {
      setPermanentBackupExporting(true)
      await exportOrdersToExcel(selectedOrders)
      setPermanentDeletionDialog((current) => current
        ? { ...current, backupDisposition: 'exported' }
        : current)
      success(`Created an Excel backup for ${selectedOrders.length} selected order(s).`)
    } catch (err) {
      error(`Unable to create the deletion backup: ${err?.message || 'Please try again.'}`)
    } finally {
      setPermanentBackupExporting(false)
    }
  }

  const continuePermanentDeletionWithoutBackup = () => {
    if (permanentDeleting || permanentBackupExporting) return
    setPermanentDeletionDialog((current) => current
      ? { ...current, backupDisposition: 'skipped' }
      : current)
  }

  const confirmPermanentOrderDeletion = async () => {
    const dialog = permanentDeletionDialog
    if (
      !dialog?.orderIds.length
      || !dialog.backupDisposition
      || permanentDeleting
      || permanentBackupExporting
    ) return

    try {
      setPermanentDeleting(true)
      const result = await permanentlyDeleteOrders(dialog.orderIds, dialog.backupDisposition)
      const succeededIds = new Set(result.succeeded)
      setOrders((currentOrders) => currentOrders.filter((order) => !succeededIds.has(order.id)))
      setSelectedOrderIds((previous) => previous.filter((id) => !succeededIds.has(id)))

      const resultByOrderId = new Map((dialog.results || []).map((item) => [item.orderId, item]))
      result.results.forEach((item) => resultByOrderId.set(item.orderId, item))
      const cumulativeResults = [...resultByOrderId.values()]
      setPermanentDeletionDialog({
        ...dialog,
        orderIds: result.failed.map(({ orderId }) => orderId),
        results: cumulativeResults,
        permanentlyDeletedCount: dialog.permanentlyDeletedCount + result.permanentlyDeletedCount,
        alreadyDeletedCount: dialog.alreadyDeletedCount + result.alreadyDeletedCount,
      })

      if (result.succeeded.length) {
        success(
          `Permanently deleted ${result.permanentlyDeletedCount} order document(s); `
          + `${result.failed.length} rejected. Financial audit records were retained.`,
        )
      }
      if (result.failed.length) {
        const firstFailure = result.failed[0]
        error(`${result.failed.length} order(s) could not be permanently deleted. ${firstFailure.orderId}: ${firstFailure.message}`)
      }
    } catch (err) {
      error(err?.message || 'Unable to permanently delete selected orders.')
    } finally {
      setPermanentDeleting(false)
    }
  }

  const confirmOrderDeletion = async () => {
    const orderIds = deletionDialog?.orderIds || []
    if (!orderIds.length) return
    try {
      setBulkDeleting(true)
      if (orderIds.length === 1) setDeletingOrderId(orderIds[0])
      const result = await deleteOrders(orderIds)
      const succeededIds = new Set(result.succeeded)
      setOrders((currentOrders) => currentOrders.map((order) => succeededIds.has(order.id)
        ? { ...order, archived: true, deleted: true }
        : order))
      setSelectedOrderIds((previous) => previous.filter((id) => !succeededIds.has(id)))
      if (result.succeeded.length) {
        success(`${result.succeeded.length} order(s) removed from the active list. Financial and audit records were retained.`)
      }
      if (result.failed.length) {
        const firstFailure = result.failed[0]
        error(`${result.failed.length} order(s) could not be deleted. ${firstFailure.orderId}: ${firstFailure.message}`)
      }
      setDeletionDialog(null)
    } catch (err) {
      error(err?.message || 'Unable to delete selected orders.')
    } finally {
      setDeletingOrderId('')
      setBulkDeleting(false)
    }
  }

  const applyDateFilter = () => {
    const validationError = validateOrderDateRange(startDateDraft, endDateDraft)
    if (validationError) {
      setDateRangeError(validationError)
      return
    }
    setDateRangeError('')
    setAppliedStartDate(startDateDraft)
    setAppliedEndDate(endDateDraft)
    setSelectedOrderIds([])
  }

  const clearDateFilter = () => {
    setStartDateDraft('')
    setEndDateDraft('')
    setAppliedStartDate('')
    setAppliedEndDate('')
    setDateRangeError('')
    setSelectedOrderIds([])
  }

  const handleExport = async () => {
    if (!filteredOrders.length || exporting || bulkDeleting || bulkUpdating || updatingOrderId) return
    try {
      setExporting(true)
      await exportOrdersToExcel(filteredOrders)
      success(`Exported ${filteredOrders.length} matching order(s) to Excel.`)
    } catch (err) {
      if (err?.message?.includes('Failed to fetch dynamically imported module')) {
        error('Excel export failed to load. Restart Vercel Dev, reload the page, and try again.')
      } else {
        error(`Unable to export orders: ${err?.message || 'Please try again.'}`)
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-brand-dusty">Review customer orders, payment status, and fulfillment.</p>
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
              onChange={(event) => { setSearchTerm(event.target.value); setSelectedOrderIds([]) }}
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
              onChange={(event) => { setPaymentStatusFilter(event.target.value); setSelectedOrderIds([]) }}
            >
              <option value="all">All Payment Statuses</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
              <option value="refunded">Refunded</option>
            </select>
          </label>

          <label className="text-sm text-brand-dusty">
            Order Status
            <select
              className="input-field mt-1"
              value={orderStatusFilter}
              onChange={(event) => { setOrderStatusFilter(event.target.value); setSelectedOrderIds([]) }}
            >
              <option value="all">All Order Statuses</option>
              {ORDER_STATUS_FILTER_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-brand-dusty">
          <input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); setSelectedOrderIds([]) }} />
          Include archived orders
        </label>
        <div className="grid gap-3 border-t border-brand-pale-rose/30 pt-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <label className="text-sm text-brand-dusty">
            Start Date
            <input
              type="date"
              className="input-field mt-1"
              value={startDateDraft}
              onChange={(event) => { setStartDateDraft(event.target.value); setDateRangeError('') }}
            />
          </label>
          <label className="text-sm text-brand-dusty">
            End Date
            <input
              type="date"
              className="input-field mt-1"
              value={endDateDraft}
              onChange={(event) => { setEndDateDraft(event.target.value); setDateRangeError('') }}
            />
          </label>
          <button type="button" className="btn-gold" onClick={applyDateFilter}>Apply Filter</button>
          <button
            type="button"
            className="btn-outline"
            onClick={clearDateFilter}
            disabled={!startDateDraft && !endDateDraft && !appliedStartDate && !appliedEndDate}
          >
            Clear Filter
          </button>
        </div>
        {dateRangeError && <p className="text-sm text-red-700" role="alert">{dateRangeError}</p>}
      </section>

      <p className="text-sm text-brand-dusty">
        Showing {filteredOrders.length} matching order(s) of {orders.filter((order) => includeArchived || !order.archived).length}
        {appliedStartDate || appliedEndDate
          ? ` · Date range: ${appliedStartDate || 'Any'} to ${appliedEndDate || 'Any'} (Asia/Kolkata)`
          : ''}
      </p>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-rose-gold/25 bg-brand-card-white p-4 shadow-soft">
        <p className="text-sm text-brand-dusty">Selected: {selectedCount}</p>

        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input-field w-56"
            value={bulkStatus}
            onChange={(event) => setBulkStatus(event.target.value)}
            disabled={bulkDeleting || permanentDeleting || exporting || bulkUpdating}
          >
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
            disabled={!selectedCount || !bulkStatus || bulkUpdating || bulkDeleting || permanentDeleting || exporting || Boolean(updatingOrderId)}
          >
            {bulkUpdating ? 'Applying...' : 'Apply'}
          </button>

          <button
            type="button"
            className="rounded-lg border border-brand-pale-rose/40 bg-brand-card-white px-4 py-2 text-sm font-medium text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => requestOrderDeletion(visibleSelectedOrderIds)}
            disabled={!selectedCount || bulkDeleting || permanentDeleting || bulkUpdating || exporting || Boolean(updatingOrderId)}
          >
            {bulkDeleting ? 'Deleting...' : 'Delete Selected'}
          </button>

          <button
            type="button"
            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => requestPermanentOrderDeletion(visibleSelectedOrderIds)}
            disabled={!selectedCount || bulkDeleting || permanentDeleting || bulkUpdating || exporting || Boolean(updatingOrderId)}
          >
            Permanently Delete Selected
          </button>

          <button
            type="button"
            className="rounded-lg border border-brand-pale-rose/40 bg-brand-card-white px-4 py-2 text-sm font-medium text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleExport}
            disabled={!filteredOrders.length || exporting || bulkDeleting || permanentDeleting || bulkUpdating || Boolean(updatingOrderId)}
          >
            {exporting ? 'Exporting...' : `Export Excel (.xlsx)${filteredOrders.length ? ` · ${filteredOrders.length}` : ''}`}
          </button>

          <button
            type="button"
            className="rounded-lg border border-brand-pale-rose/20 bg-brand-card-white px-4 py-2 text-sm font-medium text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setSelectedOrderIds([])
              setBulkStatus('')
            }}
            disabled={(!selectedCount && !bulkStatus) || permanentDeleting}
          >
            Clear
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-brand-rose-gold/25 bg-brand-card-white shadow-soft">
        {loading ? (
          <p className="p-5 text-brand-dusty">Loading orders...</p>
        ) : !filteredOrders.length ? (
          <p className="p-5 text-brand-dusty">
            {appliedStartDate || appliedEndDate
              ? 'No orders match the selected date range and filters.'
              : 'No orders found for selected filters.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="border-b border-brand-rose-gold/20 bg-brand-card-white text-sm text-brand-dusty">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      disabled={!selectableFilteredOrders.length || bulkDeleting || permanentDeleting || exporting || bulkUpdating || Boolean(updatingOrderId)}
                      onChange={toggleSelectAllFiltered}
                      aria-label="Select all filtered orders"
                    />
                  </th>
                  <th className="px-4 py-3">Order / Customer / Product</th>
                  <th className="px-4 py-3">Price / Quantity / Total</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3">Order Status</th>
                  <th className="px-4 py-3">Date &amp; time (IST)</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredOrders.map((order) => {
                  const isSelected = selectedOrderIds.includes(order.id)
                  const isUpdating = updatingOrderId === order.id
                  const isDeleting = deletingOrderId === order.id
                  const orderItems = getOrderItems(order)
                  const totalQuantity = orderItems.reduce((total, item) => total + item.quantity, 0)

                  return (
                    <tr key={order.id} className="border-b border-brand-rose-gold/15 align-top text-sm text-brand-dusty last:border-b-0">
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={Boolean(order.deletedAt || order.deleted) || bulkDeleting || permanentDeleting || exporting || bulkUpdating || Boolean(updatingOrderId)}
                          onChange={() => toggleRow(order.id)}
                          aria-label={`Select order ${order.id}`}
                        />
                      </td>

                      <td className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="mb-1 break-all text-xs text-brand-dusty">Order ID: {order.id}</p>
                            <p className="font-semibold text-brand-dusty">{order.customer?.name || '--'}</p>
                            <div className="mt-2 space-y-2">
                              {orderItems.map((item, index) => (
                                <div key={`${item.productId}-${item.selectedSize}-${index}`} className="flex items-center gap-2">
                                  <img
                                    src={item.image || order.image || 'https://placehold.co/96x96/FFF8F7/92716C?text=Order'}
                                    alt={item.productName || 'Order product'}
                                    className="h-10 w-10 rounded-lg border border-brand-rose-gold/20 bg-brand-card-white object-cover"
                                    loading="lazy"
                                  />
                                  <p className="text-brand-dusty">
                                    {item.productName || '--'} · Size: {item.selectedSize || '--'} · Qty: {item.quantity}
                                  </p>
                                </div>
                              ))}
                            </div>
                            <p className="text-brand-dusty">{order.customer?.phone || '--'}</p>
                            <p className="max-w-xs text-brand-dusty">{order.customer?.address || '--'}</p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-4">
                        <div className="space-y-2">
                          {orderItems.map((item, index) => (
                            <div key={`${item.productId}-${item.selectedSize}-${index}`} className="text-brand-dusty">
                              <p>Unit: {formatINR(item.price)} · Qty: {item.quantity}</p>
                              <p>Line total: {formatINR(item.price * item.quantity)}</p>
                            </div>
                          ))}
                        </div>
                        <p className="mt-2 font-semibold text-brand-dusty">
                          Qty: {getOrderReservedQuantity(order) ?? totalQuantity} · Order total: {formatINR(getOrderTotal(order))}
                        </p>
                      </td>

                      <td className="px-4 py-4">
                        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${paymentBadgeClass(order.paymentStatus === 'captured' ? 'paid' : order.paymentStatus)}`}>
                          {order.paymentMethod === 'razorpay' && order.paymentStatus === 'pending'
                            ? 'Pending verification'
                            : order.paymentStatus === 'captured'
                              ? 'Paid'
                              : order.paymentStatus === 'failed'
                                ? 'Failed'
                                : order.paymentStatus === 'authorized'
                                  ? 'Authorized'
                              : order.paymentStatus || 'pending'}
                        </span>
                        <p className="mt-1 text-brand-dusty">{order.paymentMethod || '--'}</p>
                        {order.paymentMethod === 'razorpay' && ['pending', 'authorized'].includes(order.paymentStatus) && (
                          <p className="mt-1 text-xs text-amber-800">
                            {order.stockReserved === false
                              ? 'Status is being verified; stock hold was released, so a late capture needs inventory review.'
                              : 'Status is being verified; reserved stock remains held.'}
                          </p>
                        )}
                        {order.paymentMethod === 'razorpay' && order.paymentStatus === 'failed' && order.stockReserved === true && (
                          <p className="mt-1 text-xs text-amber-800">
                            Payment failed; inventory release is still being reconciled.
                          </p>
                        )}
                        {order.paymentReconciliationStatus === 'manual_review' && (
                          <p className="mt-1 text-xs text-red-700">
                            Manual review required{order.refundRequired ? ' · refund required' : ''}.
                          </p>
                        )}
                        {order.refundRequired && (
                          <p className="mt-1 text-xs text-red-700">
                            Refund: {order.refundStatus || 'requested'}
                            {order.refundId ? ` · ${order.refundId}` : ''}
                            {order.refundAmountPaise ? ` · ${formatINR(order.refundAmountPaise / 100)}` : ''}
                          </p>
                        )}
                        {order.razorpayPaymentId && <p className="truncate text-xs text-brand-dusty">ID: {order.razorpayPaymentId}</p>}
                      </td>

                      <td className="px-4 py-4">
                        {getDisplayedOrderStatus(order) === 'cancelled' ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700" aria-label="Order status cancelled">
                            cancelled
                          </span>
                        ) : (
                          <select
                            className="input-field min-w-40"
                            value={getDisplayedOrderStatus(order)}
                            onChange={(event) => handleOrderStatusUpdate(order.id, event.target.value)}
                            disabled={isUpdating || bulkUpdating || bulkDeleting || permanentDeleting || exporting || getAllowedOrderStatusOptions(order).length < 2}
                          >
                            {getAllowedOrderStatusOptions(order).map((status) => (
                              <option key={status} value={status}>
                                {status}
                              </option>
                            ))}
                          </select>
                        )}
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
                          {order.paymentMethod === 'razorpay' && order.paymentStatus === 'captured' && order.refundStatus !== 'processed' && (
                            <button
                              type="button"
                              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                              onClick={async () => {
                                try {
                                  await adminReservationAction({ action: 'retry-refund', reservationId: order.reservationId })
                                  success('Full refund request submitted; check the order record for its latest status.')
                                } catch (err) {
                                  error(err?.message || 'Unable to retry refund.')
                                }
                              }}
                            >
                              {order.refundStatus === 'failed' ? 'Retry full refund' : 'Request full refund'}
                            </button>
                          )}
                          {order.reservationId && order.reservationStatus === 'converted' && !order.stockRestored && (
                            <button
                              type="button"
                              className="rounded-lg border border-brand-pale-rose/40 px-3 py-1.5 text-sm text-brand-dusty hover:bg-brand-blush"
                              onClick={async () => {
                                if (!window.confirm('Explicitly restore physical stock for this cancelled/refunded order?')) return
                                try {
                                  const result = await adminReservationAction({ action: 'restock-cancelled', reservationId: order.reservationId, reason: 'Admin restocked cancelled/refunded goods' })
                                  if (
                                    result.success !== true ||
                                    result.status !== 'restocked' ||
                                    result.orderId !== order.id ||
                                    result.orderStatus !== 'cancelled' ||
                                    result.reservationStatus !== 'converted' ||
                                    result.stockRestored !== true
                                  ) {
                                    throw new Error('Restock succeeded, but the updated order status was not returned.')
                                  }
                                  setOrders((currentOrders) => applyReservationRestock(currentOrders, result))
                                  success('Physical stock restored once.')
                                } catch (err) {
                                  error(err?.message || 'Unable to restock order.')
                                }
                              }}
                            >
                              Restock
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-lg border border-brand-pale-rose/40 bg-brand-card-white px-3 py-1.5 text-sm text-brand-dusty disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => requestOrderDeletion([order.id])}
                            disabled={isDeleting || bulkDeleting || permanentDeleting || exporting || Boolean(order.deletedAt || order.deleted)}
                          >
                            {order.deletedAt || order.deleted ? 'Retained' : isDeleting ? 'Deleting...' : 'Delete'}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-semibold text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => requestPermanentOrderDeletion([order.id])}
                            disabled={isDeleting || bulkDeleting || permanentDeleting || exporting || bulkUpdating || Boolean(updatingOrderId)}
                          >
                            Permanently Delete
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

      {deletionDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-4" role="presentation">
          <section
            className="w-full max-w-lg rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-royal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-orders-title"
          >
            <h2 id="delete-orders-title" className="font-display text-2xl text-brand-burgundy">
              Delete {deletionDialog.orderIds.length} selected order(s)?
            </h2>
            <p className="mt-3 text-sm leading-6 text-brand-dusty">
              Orders with active holds, pending payments, unresolved refunds, or unfinished paid fulfillment will be rejected.
              Financial, payment, refund, webhook, and inventory audit records are retained; eligible orders are hidden from the active list, not permanently erased.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="btn-outline" onClick={() => setDeletionDialog(null)} disabled={bulkDeleting}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white disabled:opacity-50"
                onClick={confirmOrderDeletion}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? 'Deleting...' : `Confirm Delete (${deletionDialog.orderIds.length})`}
              </button>
            </div>
          </section>
        </div>
      )}

      {permanentDeletionDialog && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 px-4 py-6" role="presentation">
          <section
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-red-200 bg-brand-card-white p-6 shadow-royal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="permanent-delete-orders-title"
          >
            <h2 id="permanent-delete-orders-title" className="font-display text-2xl text-red-800">
              {permanentDeletionDialog.orderIds.length
                ? `Permanently delete ${permanentDeletionDialog.orderIds.length} order(s)?`
                : 'Permanent deletion report'}
            </h2>
            {permanentDeletionDialog.orderIds.length > 0 && (
              <>
                <p className="mt-3 text-sm leading-6 text-brand-dusty">
                  This cannot be undone. The server will recheck every order immediately before deleting its Firestore order document.
                  Orders with unresolved payments, refunds, inventory holds, fulfillment, issues, or unreviewed subcollections will be rejected.
                </p>
                <div className="mt-4 rounded-xl border border-brand-pale-rose/50 bg-brand-blush/40 p-4">
                  <p className="text-sm font-semibold text-brand-burgundy">Review the backup option</p>
                  <p className="mt-1 text-sm leading-5 text-brand-dusty">
                    Download an Excel backup of the selected orders, including customer and product details, totals, statuses, and available payment references.
                    You may continue without it, but a backup is recommended before permanent deletion.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={handlePermanentDeletionBackup}
                      disabled={permanentBackupExporting || permanentDeleting}
                    >
                      {permanentBackupExporting ? 'Creating backup...' : 'Download selected orders backup (.xlsx)'}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      onClick={continuePermanentDeletionWithoutBackup}
                      disabled={permanentBackupExporting || permanentDeleting}
                    >
                      Continue without backup
                    </button>
                  </div>
                  {permanentDeletionDialog.backupDisposition === 'exported' && (
                    <p className="mt-2 text-sm text-emerald-800" role="status">
                      Excel backup generated and download initiated. You may now proceed.
                    </p>
                  )}
                  {permanentDeletionDialog.backupDisposition === 'skipped' && (
                    <p className="mt-2 text-sm text-amber-900" role="status">
                      Backup skipped by choice. The deletion report will still retain financial transaction references.
                    </p>
                  )}
                </div>
              </>
            )}

            {permanentDeletionDialog.results.length > 0 && (
              <div className="mt-4 space-y-2 rounded-xl border border-brand-pale-rose/50 p-4 text-sm text-brand-dusty">
                <p>
                  Order documents permanently deleted: <strong>{permanentDeletionDialog.permanentlyDeletedCount}</strong>
                  {' · '}Already deleted with audit retained: <strong>{permanentDeletionDialog.alreadyDeletedCount}</strong>
                  {' · '}Rejected: <strong>{permanentDeletionDialog.results.filter((item) => !item.success).length}</strong>
                </p>
                <p>Related order subcollections removed: 0. Orders with any subcollections are rejected without deletion.</p>
                <p>
                  Financial snapshots are retained in <code>orderDeletionAudits</code>. Inventory history, reservation idempotency records,
                  reservation tokens, webhook events, and product stock are left unchanged.
                </p>
                <p>Firestore storage/billing metrics may take time to update; the amount of storage freed is not measured by this feature.</p>
                {permanentDeletionDialog.results.some((item) => !item.success) && (
                  <ul className="list-disc space-y-1 pl-5 text-red-800">
                    {permanentDeletionDialog.results.filter((item) => !item.success).map((item) => (
                      <li key={item.orderId}>{item.orderId}: {item.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setPermanentDeletionDialog(null)}
                disabled={permanentDeleting || permanentBackupExporting}
              >
                {permanentDeletionDialog.orderIds.length ? 'Cancel' : 'Close report'}
              </button>
              {permanentDeletionDialog.orderIds.length > 0 && (
                <button
                  type="button"
                  className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={confirmPermanentOrderDeletion}
                  disabled={!permanentDeletionDialog.backupDisposition || permanentDeleting || permanentBackupExporting}
                >
                  {permanentDeleting
                    ? 'Deleting...'
                    : permanentDeletionDialog.results.length
                      ? `Retry failed orders (${permanentDeletionDialog.orderIds.length})`
                      : `Permanently Delete (${permanentDeletionDialog.orderIds.length})`}
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {viewingOrder && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-xl rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-royal">
            <h3 className="font-display text-2xl text-brand-dusty">Order Details</h3>

            <div className="mt-4 grid gap-4">
              <div className="space-y-1 text-sm text-brand-dusty">
                <p><span className="font-medium">Order ID:</span> {viewingOrder.id}</p>
                <div className="space-y-3">
                  {getOrderItems(viewingOrder).map((item, index) => (
                    <div key={`${item.productId}-${item.selectedSize}-${index}`} className="flex items-center gap-3 rounded-lg border border-brand-pale-rose/50 p-3">
                      <img
                        src={item.image || viewingOrder.image || 'https://placehold.co/120x120/FFF8F7/92716C?text=Order'}
                        alt={item.productName || 'Order product'}
                        className="h-16 w-16 rounded-lg border border-brand-rose-gold/20 bg-brand-card-white object-cover"
                        loading="lazy"
                      />
                      <div>
                        <p className="font-medium">{item.productName || '--'}</p>
                        <p>Size: {item.selectedSize || '--'} · Quantity: {item.quantity}</p>
                        <p>Unit price: {formatINR(item.price)} · Line total: {formatINR(item.price * item.quantity)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p><span className="font-medium">Order total:</span> {formatINR(getOrderTotal(viewingOrder))}</p>
                <p><span className="font-medium">Customer:</span> {viewingOrder.customer?.name || '--'}</p>
                <p><span className="font-medium">Phone:</span> {viewingOrder.customer?.phone || '--'}</p>
                <p><span className="font-medium">Address:</span> {viewingOrder.customer?.address || '--'}</p>
                <p><span className="font-medium">Payment:</span> {viewingOrder.paymentMethod || '--'} / {viewingOrder.paymentStatus || '--'}</p>
                <p><span className="font-medium">Order Status:</span> {viewingOrder.orderStatus || '--'}</p>
                <p><span className="font-medium">Razorpay payment ID:</span> {viewingOrder.razorpayPaymentId || '--'}</p>
                {Object.keys(viewingOrder.paymentAttempts || {}).length > 0 && (
                  <div>
                    <p className="font-medium">Payment attempts:</p>
                    <ul className="mt-1 space-y-1">
                      {Object.values(viewingOrder.paymentAttempts).map((attempt, index) => (
                        <li key={`${attempt.razorpayOrderId || 'attempt'}-${index}`}>
                          Attempt {index + 1}: {attempt.status || 'pending'}
                          {Number.isSafeInteger(attempt.amount) ? ` · ${formatINR(attempt.amount / 100)}` : ''}
                          {attempt.razorpayOrderId ? ` · ${attempt.razorpayOrderId}` : ''}
                          {attempt.paymentId ? ` · ${attempt.paymentId}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p><span className="font-medium">Order placed:</span> {formatDate(viewingOrder.createdAt)}</p>
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
