import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import ReservationCustomerFields from '../components/ReservationCustomerFields'
import { useCart } from '../hooks/useCart'
import { useProducts } from '../hooks/useProducts'
import { useToast } from '../hooks/useToast'
import {
  createCheckoutIdempotencyKey,
  createCheckoutReservation,
  getCustomerReservationCheckoutKey,
  getCustomerReservationStatusWithToken,
  rememberCustomerReservation,
} from '../services/reservationService'
import {
  checkoutReservation,
  isConfirmedCheckoutResult,
} from '../services/razorpayService'
import { getStoreSettings } from '../services/storeSettingsService'
import clientConfig from '../config/clientConfig'
import { formatINR } from '../utils/formatters'
import {
  buildCustomerAddress,
  CUSTOMER_DETAILS_STORAGE_KEY,
  DEFAULT_CUSTOMER_DETAILS,
  normalizeCustomerDetails,
  normalizeCustomerSubmission,
  validateCustomerDetails,
} from '../../shared/customerValidation.js'
import {
  getCartItemCount,
  getCartAvailabilityErrors,
  getCartSubtotal,
} from '../utils/cart'
import { completeOrderWhatsAppHandoffs } from '../utils/whatsappOrder'

function readSavedCustomer() {
  const saved = localStorage.getItem(CUSTOMER_DETAILS_STORAGE_KEY)
  if (!saved) return { ...DEFAULT_CUSTOMER_DETAILS }
  try {
    return normalizeCustomerDetails(JSON.parse(saved))
  } catch {
    return { ...DEFAULT_CUSTOMER_DETAILS }
  }
}

function addConfirmedOrderSummary(message, count) {
  if (!count) return message
  return `${message} ${count} earlier order${count === 1 ? ' was' : 's were'} confirmed and saved in My Orders.`
}

function appendWhatsAppNotice(message, notice) {
  if (!message || message.includes(notice.trim())) return message
  return `${message}${notice}`
}

export default function CartPage() {
  const {
    items: cartItems,
    removeFromCart,
    setQuantity,
    clearCart,
    buyNowItem,
    setBuyNowQuantity,
    clearBuyNow,
  } = useCart()
  const [searchParams] = useSearchParams()
  const isBuyNowCheckout = searchParams.get('mode') === 'buy-now'
  const items = isBuyNowCheckout ? (buyNowItem ? [buyNowItem] : []) : cartItems
  const itemCount = getCartItemCount(items)
  const { products, loading, error: catalogueError, reload: reloadProducts } = useProducts(true)
  const { success, error } = useToast()
  const [customer, setCustomer] = useState(readSavedCustomer)
  const [touched, setTouched] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [checkoutMode, setCheckoutMode] = useState('')
  const [checkoutMessage, setCheckoutMessage] = useState('')
  const [checkoutMessageTone, setCheckoutMessageTone] = useState('')
  const [checkoutFailures, setCheckoutFailures] = useState([])
  const [orderWhatsAppLinks, setOrderWhatsAppLinks] = useState([])
  const [storeContactError, setStoreContactError] = useState('')
  const [confirmedOrderSummary, setConfirmedOrderSummary] = useState(null)
  const checkoutLockRef = useRef(false)

  const updateQuantity = (productId, quantity, availableStock) => {
    if (isBuyNowCheckout) setBuyNowQuantity(productId, quantity, availableStock)
    else setQuantity(productId, quantity, availableStock)
  }
  const removeCheckoutItem = (productId) => {
    if (isBuyNowCheckout) clearBuyNow()
    else removeFromCart(productId)
  }
  const clearCheckout = () => {
    if (isBuyNowCheckout) clearBuyNow()
    else clearCart()
  }
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const customerErrors = validateCustomerDetails(customer)
  const cartRows = items.map((item) => ({
    item,
    product: productsById.get(item.id) || null,
  }))
  const stockErrors = loading ? [] : getCartAvailabilityErrors(items, products)
  const stockErrorsById = new Map(stockErrors.map((issue) => [issue.productId, issue.message]))
  const subtotal = getCartSubtotal(items, productsById)
  const isCheckoutFormValid = items.length > 0
    && !loading
    && !catalogueError
    && Object.keys(customerErrors).length === 0
    && !submitting
  const isCheckoutValid = isCheckoutFormValid && stockErrors.length === 0

  const handleOnlineCheckout = async () => {
    if (checkoutLockRef.current) return
    setTouched(Object.fromEntries(Object.keys(customer).map((field) => [field, true])))
    setCheckoutMessage('')
    setCheckoutMessageTone('')
    setCheckoutFailures([])
    setConfirmedOrderSummary(null)
    if (Object.keys(customerErrors).length) return
    if (!items.length || loading || catalogueError) return
    const currentStockErrors = getCartAvailabilityErrors(items, products)
    if (currentStockErrors.length) {
      setCheckoutMessage('Update or remove unavailable items before starting payment.')
      return
    }

    checkoutLockRef.current = true
    setSubmitting(true)
    setCheckoutMode('payment')
    setOrderWhatsAppLinks([])
    setStoreContactError('')
    const submittedCustomer = normalizeCustomerSubmission(customer)
    const confirmedOrders = []

    try {
      localStorage.setItem(CUSTOMER_DETAILS_STORAGE_KEY, JSON.stringify(submittedCustomer))
      setCustomer(submittedCustomer)

      const checkoutItems = [...items]
      const productName = checkoutItems
        .map((item) => productsById.get(item.id)?.name || item.name || 'Product')
        .join(', ')
      const result = await checkoutReservation({
        items: checkoutItems,
        customer: submittedCustomer,
        productName: productName || 'GV Sarees order',
      }, {
        createReservation: createCheckoutReservation,
        rememberReservation: rememberCustomerReservation,
        getCheckoutKey: getCustomerReservationCheckoutKey,
        createCheckoutKey: createCheckoutIdempotencyKey,
        getStatus: getCustomerReservationStatusWithToken,
      })

      if (result.status === 'captured') {
        if (isConfirmedCheckoutResult(result)) {
          const reservation = result.reservation || {}
          const sourceItems = result.items?.length ? result.items : reservation.items
          const confirmedItems = (sourceItems?.length ? sourceItems : checkoutItems.map((item) => {
            const product = productsById.get(item.id)
            return {
              productId: item.id,
              productName: product?.name || item.name || 'Product',
              quantity: item.quantity,
              price: product?.price ?? item.price ?? 0,
            }
          })).map((confirmedItem) => ({
            productId: confirmedItem.productId || confirmedItem.id,
            productName: confirmedItem.productName || confirmedItem.name || 'Product',
            quantity: confirmedItem.quantity ?? confirmedItem.reservedQuantity ?? 0,
            unitPrice: Number(confirmedItem.price ?? confirmedItem.unitPrice ?? 0),
            selectedSize: confirmedItem.selectedSize || confirmedItem.sizeLength || '',
            image: confirmedItem.image || '',
          }))
          confirmedOrders.push({
            paymentStatus: result.status,
            orderStatus: result.orderStatus,
            orderId: result.orderId,
            paymentId: result.paymentId,
            customer: {
              ...submittedCustomer,
              address: buildCustomerAddress(submittedCustomer),
            },
            products: confirmedItems,
            totalAmount: Number.isSafeInteger(result.paymentAmountPaise)
              ? result.paymentAmountPaise / 100
              : Number(result.totalAmount ?? reservation.totalAmount ?? confirmedItems.reduce(
                (total, product) => total + product.quantity * product.unitPrice,
                0,
              )),
          })
          setConfirmedOrderSummary(confirmedOrders[0])
          clearCheckout()
          setCheckoutMessage('Payment captured and verified. Your order is confirmed and saved in My Orders.')
          setCheckoutMessageTone('success')
          success('Payment captured and order confirmed.')
        } else {
          setCheckoutMessage('Payment was captured, but order fulfillment is still being reconciled. The order remains tracked; check My Orders before retrying.')
          setCheckoutMessageTone('pending')
        }
      } else if (result.checkoutStatus === 'cancelled') {
        await reloadProducts()
        const message = !result.dismissalReconciled
          ? `Checkout was closed, but the server could not confirm inventory release: ${result.dismissalError || 'unknown error'}. Your cart quantity is unchanged; check My Orders before retrying.`
          : result.status === 'authorized'
            ? 'Payment was authorized and is awaiting capture. Your stock remains protected; check My Orders before retrying.'
            : result.inventoryStatus === 'released'
              ? result.status === 'pending'
                ? 'Checkout was closed and stock was released, but the previous payment is still being verified. Your cart is unchanged; avoid another payment until its status is confirmed.'
                : 'Checkout was closed and the reserved stock was released. Your cart quantity is unchanged; adjust it and retry whenever you are ready.'
              : 'Checkout was closed. Payment status is unresolved; inventory cleanup will retry automatically. Check My Orders before retrying.'
        setCheckoutMessage(message)
        setCheckoutMessageTone(result.dismissalReconciled && result.inventoryStatus === 'released' ? 'pending' : 'error')
      } else if (result.checkoutStatus === 'failed' || result.status === 'failed') {
        const message = result.inventoryStatus === 'held'
          ? 'This payment attempt failed, but stock remains reserved while payment status is reconciled. Check My Orders before retrying.'
          : 'Razorpay confirmed the payment failure and released the reserved stock. You can change the quantity and retry checkout.'
        setCheckoutMessage(message)
        setCheckoutMessageTone('error')
      } else if (result.status === 'authorized') {
        setCheckoutMessage('Payment authorized and awaiting capture. Check My Orders for the latest status before retrying.')
        setCheckoutMessageTone('pending')
      } else {
        setCheckoutMessage('Payment is still pending. Check My Orders for updates before retrying.')
        setCheckoutMessageTone('pending')
      }
    } catch (checkoutError) {
      const message = checkoutError?.message || 'Unable to complete online checkout.'
      setCheckoutMessage(addConfirmedOrderSummary(
        `Checkout did not complete: ${message} Check My Orders before trying again.`,
        confirmedOrders.length,
      ))
      setCheckoutMessageTone('error')
      setCheckoutFailures([{ productName: 'Payment', message }])
      error(message)
    } finally {
      if (confirmedOrders.length) {
        const results = await completeOrderWhatsAppHandoffs(confirmedOrders, getStoreSettings)
        const retryLink = results.find((result) => result.url)
        const whatsappLinks = retryLink
          ? [{
            orderId: confirmedOrders.map(({ orderId }) => orderId).join(', '),
            url: retryLink.url,
          }]
          : []
        setOrderWhatsAppLinks(whatsappLinks)

        const fallbackReason = results.find((result) => result.reason)?.reason
        if (fallbackReason === 'settings-load-failed') {
          setStoreContactError('Store WhatsApp settings could not be loaded. Use the retry link below to open the existing store WhatsApp contact.')
        } else if (fallbackReason === 'not-configured' || fallbackReason === 'invalid-number') {
          setStoreContactError('The configured store WhatsApp number is missing or invalid. Use the retry link below to open the existing store WhatsApp contact.')
        } else if (fallbackReason === 'navigation-failed') {
          setStoreContactError('WhatsApp could not be opened automatically. Use the same-tab retry link below.')
        } else if (fallbackReason === 'url-generation-failed') {
          setStoreContactError('A valid WhatsApp link could not be created. Your confirmed order remains saved; please contact the store directly.')
        }

        const notice = results.some((result) => result.status === 'opened')
          ? ' WhatsApp opened with a prefilled message; review it and press Send. Closing WhatsApp does not affect the confirmed order.'
          : whatsappLinks.length
            ? ' If WhatsApp did not open automatically, use Continue to WhatsApp below.'
            : ''
        if (notice) {
          setCheckoutMessage((message) => appendWhatsAppNotice(message, notice))
        }
      }
      setSubmitting(false)
      setCheckoutMode('')
      checkoutLockRef.current = false
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-brand-pale-rose/30 pb-6">
        <div>
          <p className="eyebrow-line">Your selection</p>
          <h1 className="section-title">{isBuyNowCheckout ? 'Buy now checkout' : 'Shopping cart'}</h1>
          <p className="mt-3 text-sm text-brand-dusty">
            {isBuyNowCheckout
              ? `Checkout contains only your selected item. Your saved cart is unchanged. ${itemCount} item(s) · Stock is held only when you begin secure checkout.`
              : `${itemCount} item(s) · Stock is held only when you begin secure checkout.`}
          </p>
        </div>
        <Link to="/products" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-dusty hover:text-brand-rose-gold">
          <ArrowLeft size={16} /> Continue shopping
        </Link>
      </div>

      {confirmedOrderSummary && (
        <section className="mb-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950" aria-label="Confirmed order">
          <h2 className="font-display text-2xl">Order confirmed</h2>
          <p className="mt-1 text-sm">Order ID: {confirmedOrderSummary.orderId}</p>
          <ul className="mt-4 divide-y divide-emerald-200">
            {confirmedOrderSummary.products.map((product) => (
              <li key={`${product.productId}-${product.selectedSize}`} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                <span>{product.productName}{product.selectedSize ? ` · Size ${product.selectedSize}` : ''} × {product.quantity}</span>
                <span>{formatINR(product.unitPrice * product.quantity)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-emerald-200 pt-3 text-right font-semibold">
            Total: {formatINR(confirmedOrderSummary.totalAmount)}
          </p>
        </section>
      )}

      {!items.length ? (
        <section className="rounded-2xl border border-dashed border-brand-rose-gold/50 bg-brand-card-white px-6 py-16 text-center shadow-soft">
          <ShoppingCart className="mx-auto text-brand-rose-gold" size={38} />
          <h2 className="mt-4 font-display text-3xl text-brand-burgundy">
            {isBuyNowCheckout ? 'Your Buy Now selection is empty' : 'Your cart is empty'}
          </h2>
          <p className="mt-2 text-sm text-brand-dusty">Choose a piece from the catalogue to start your order.</p>
          <Link to="/products" className="btn-gold mt-6">Explore the catalogue</Link>
        </section>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
          <section className="space-y-4">
            {catalogueError && (
              <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
                Current catalogue stock could not be checked. Try again before starting payment.
              </p>
            )}
            {cartRows.map(({ item, product }, index) => {
              const availabilityMessage = stockErrorsById.get(item.id)
              const availableStock = Number.isSafeInteger(product?.availableStock) ? product.availableStock : 0
              const image = product?.images?.[0]?.url || product?.images?.[0] || item.image || clientConfig.logo
              const name = product?.name || item.name || 'Unavailable product'
              const price = product ? product.price : item.price

              return (
                <article key={item.id} className="flex flex-col gap-4 rounded-2xl border border-brand-rose-gold/20 bg-brand-card-white p-4 shadow-soft sm:flex-row">
                  <img
                    src={typeof image === 'string' ? image : image?.url || clientConfig.logo}
                    alt={name}
                    className="h-36 w-full rounded-xl bg-brand-blush object-cover sm:h-32 sm:w-28"
                    loading={index === 0 ? 'eager' : 'lazy'}
                    fetchPriority={index === 0 ? 'high' : 'auto'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-display text-xl text-brand-burgundy">{name}</h2>
                        <p className="mt-1 text-sm font-semibold text-brand-dusty">{formatINR(price)}</p>
                        {item.sizeLength && <p className="mt-1 text-xs text-brand-dusty">Size: {item.sizeLength}</p>}
                      </div>
                      <button
                        type="button"
                        className="rounded-full p-2 text-brand-dusty hover:bg-brand-blush"
                        aria-label={`Remove ${name} from cart`}
                        onClick={() => removeCheckoutItem(item.id)}
                        disabled={submitting}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="inline-flex items-center rounded-full border border-brand-pale-rose">
                        <button
                          type="button"
                          className="p-2 text-brand-dusty disabled:opacity-40"
                          aria-label={`Decrease ${name} quantity`}
                          disabled={item.quantity <= 1 || submitting}
                          onClick={() => updateQuantity(item.id, item.quantity - 1, product ? availableStock : undefined)}
                        >
                          <Minus size={15} />
                        </button>
                        <span className="min-w-8 text-center text-sm font-semibold" aria-label="Quantity">{item.quantity}</span>
                        <button
                          type="button"
                          className="p-2 text-brand-dusty disabled:opacity-40"
                          aria-label={`Increase ${name} quantity`}
                          disabled={!product || item.quantity >= availableStock || submitting}
                          onClick={() => updateQuantity(item.id, item.quantity + 1, availableStock)}
                        >
                          <Plus size={15} />
                        </button>
                      </div>
                      <p className="font-semibold text-brand-burgundy">{formatINR(Number(price || 0) * item.quantity)}</p>
                    </div>
                    {loading && <p className="mt-3 text-xs text-brand-dusty">Checking current stock…</p>}
                    {!loading && availabilityMessage && <p className="mt-3 text-sm text-red-700" role="alert">{availabilityMessage}</p>}
                  </div>
                </article>
              )
            })}
            <button type="button" className="text-sm font-semibold text-brand-dusty underline underline-offset-4" onClick={clearCheckout} disabled={submitting}>
              {isBuyNowCheckout ? 'Clear Buy Now selection' : 'Clear cart'}
            </button>
          </section>

          <aside className="rounded-2xl border border-brand-rose-gold/25 bg-brand-card-white p-5 shadow-soft sm:p-6">
            <div className="flex items-center justify-between border-b border-brand-pale-rose/30 pb-4">
              <h2 className="font-display text-2xl text-brand-burgundy">Order summary</h2>
              <span className="text-sm text-brand-dusty">{itemCount} item(s)</span>
            </div>
            <div className="flex justify-between py-4 text-sm text-brand-dusty">
              <span>Subtotal</span>
              <span className="font-semibold text-brand-burgundy">{formatINR(subtotal)}</span>
            </div>
            <p className="border-b border-brand-pale-rose/30 pb-4 text-xs leading-5 text-brand-dusty">
              Prices and stock are validated by the server when payment starts. Adding items to the cart does not hold stock.
            </p>

            <div className="mt-5">
              <h3 className="mb-3 text-sm font-semibold text-brand-burgundy">Customer details</h3>
              <ReservationCustomerFields
                customer={customer}
                errors={customerErrors}
                touched={touched}
                onChange={(field, value) => setCustomer((previous) => ({ ...previous, [field]: value }))}
                onBlur={(field) => setTouched((previous) => ({ ...previous, [field]: true }))}
                disabled={submitting}
              />
            </div>

            {checkoutMessage && (
              <p className={`mt-4 text-sm ${
                checkoutMessageTone === 'error'
                  ? 'text-red-700'
                  : checkoutMessageTone === 'pending'
                    ? 'text-amber-800'
                    : checkoutMessageTone === 'success'
                      ? 'text-emerald-700'
                      : checkoutFailures.length ? 'text-red-700' : 'text-emerald-700'
              }`} role="status">
                {checkoutMessage}
              </p>
            )}
            {storeContactError && <p className="mt-3 text-sm text-amber-800" role="status">{storeContactError}</p>}
            {orderWhatsAppLinks.length > 0 && (
              <div className="mt-4 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <p>Order confirmed. If WhatsApp did not open automatically, continue using this link. Review the prefilled message and press Send; closing WhatsApp does not affect your order.</p>
                {orderWhatsAppLinks.map(({ orderId, url }) => (
                  <a
                    key={orderId}
                    href={url}
                    className="btn-gold w-full"
                  >
                    Continue to WhatsApp to review order details
                  </a>
                ))}
              </div>
            )}
            <button type="button" className="btn-gold mt-6 w-full disabled:cursor-not-allowed disabled:opacity-50" onClick={handleOnlineCheckout} disabled={!isCheckoutValid}>
              {submitting && checkoutMode === 'payment' ? 'Preparing secure checkout…' : 'Pay online with Razorpay'}
            </button>
            <p className="mt-4 rounded-xl border border-brand-rose-gold/30 bg-brand-blush/50 p-3 text-sm leading-6 text-brand-burgundy" role="note">
              After successful online payment, your order will be forwarded to WhatsApp for confirmation. Please review the pre-filled message and press Send.
            </p>
            <p className="mt-3 text-center text-xs text-brand-dusty">
              Stock is held when checkout begins. Razorpay verifies payment and confirms the order automatically.
            </p>
          </aside>
        </div>
      )}
    </div>
  )
}
