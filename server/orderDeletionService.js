import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import './firebaseAdmin.js'
import { assertOrderCanDelete, assertOrderCanPermanentlyDelete } from './orderPolicy.js'

const db = getFirestore()

const SAFE_DELETION_ERRORS = new Set([
  'ACTIVE_RESERVATION',
  'PAYMENT_UNRESOLVED',
  'REFUND_UNRESOLVED',
  'ORDER_NOT_TERMINAL',
  'ORDER_NOT_FOUND',
])

const PERMANENT_DELETION_ERRORS = new Set([
  ...SAFE_DELETION_ERRORS,
  'ORDER_AUDIT_EXISTS',
  'ORDER_HAS_SUBCOLLECTIONS',
  'INVENTORY_RECONCILIATION_REQUIRED',
  'ORDER_ISSUE_UNRESOLVED',
])

const AUDIT_FIELDS = [
  'createdAt',
  'orderStatus',
  'paymentMethod',
  'paymentStatus',
  'paymentAmountPaise',
  'paymentCurrency',
  'paymentIdempotencyKeyHash',
  'paymentVerifiedAt',
  'paymentReconciliationStatus',
  'paymentReconciliationReason',
  'razorpayOrderId',
  'razorpayOrderIds',
  'razorpayReceipts',
  'razorpayPaymentId',
  'refundRequired',
  'refundStatus',
  'refundId',
  'refundPaymentId',
  'refundProviderStatus',
  'refundAmountPaise',
  'refundRequestedAt',
  'refundProcessedAt',
  'refundFailedAt',
  'refundReason',
  'refundErrorCode',
  'reservationId',
  'reservationStatus',
  'stockDeducted',
  'stockRestored',
  'inventoryOwnershipStatus',
  'stockReleasedAt',
  'stockReacquiredAt',
  'productId',
  'productName',
  'orderItems',
  'items',
  'products',
  'reservedQuantity',
  'quantity',
  'price',
  'subtotal',
  'subtotalPaise',
  'shippingCharge',
  'shippingChargePaise',
  'shippingAmount',
  'discount',
  'discountPaise',
  'discountAmount',
  'totalAmount',
  'totalAmountPaise',
]

const PAYMENT_ATTEMPT_FIELDS = [
  'status',
  'amount',
  'currency',
  'receipt',
  'createdAt',
  'razorpayOrderId',
  'paymentId',
  'verifiedAt',
]

function copyFields(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]))
}

function retainPaymentAttempts(attempts = {}) {
  return Object.fromEntries(Object.entries(attempts).map(([key, attempt]) => {
    const retained = copyFields(attempt, PAYMENT_ATTEMPT_FIELDS)
    if (attempt.payments && typeof attempt.payments === 'object' && !Array.isArray(attempt.payments)) {
      retained.payments = Object.fromEntries(Object.entries(attempt.payments).map(([paymentId, payment]) => [
        paymentId,
        copyFields(payment, ['status']),
      ]))
    }
    return [key, retained]
  }))
}

function createFinancialAudit(orderId, order, adminUid, deletedAt) {
  const financialRecord = copyFields(order, AUDIT_FIELDS)
  if (order.paymentAttempts && typeof order.paymentAttempts === 'object' && !Array.isArray(order.paymentAttempts)) {
    financialRecord.paymentAttempts = retainPaymentAttempts(order.paymentAttempts)
  }
  return {
    schemaVersion: 1,
    orderId,
    deletedAt,
    deletedBy: adminUid,
    financialRecord,
  }
}

function assertInventoryHistoryIsReconciled(orderId, order, historySnapshot) {
  if (!order.reservationId) return
  const records = historySnapshot.docs.map((document) => document.data())
  if (!records.length || records.some((record) =>
    record.orderId !== orderId
    || record.reservationId !== order.reservationId
    || record.productId !== order.productId,
  )) {
    throw Object.assign(new Error('Inventory history is missing or inconsistent for this reservation.'), {
      code: 'INVENTORY_RECONCILIATION_REQUIRED',
    })
  }

  const actionTypes = new Set(records.map((record) => record.actionType))
  const finalAction = order.stockRestored === true
    ? 'restock'
    : order.reservationStatus === 'converted' && order.stockDeducted === true
      ? 'convert'
      : order.reservationStatus === 'released'
        ? 'release'
        : order.reservationStatus === 'expired'
          ? 'expire'
          : null
  if (!finalAction || !actionTypes.has(finalAction)) {
    throw Object.assign(new Error("Inventory history does not confirm the order's final stock state."), {
      code: 'INVENTORY_RECONCILIATION_REQUIRED',
    })
  }
}

function getDeletionError(error) {
  if (SAFE_DELETION_ERRORS.has(error?.code)) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'ORDER_DELETE_FAILED',
    message: 'The order could not be deleted. Try again or contact support.',
  }
}

function getPermanentDeletionError(error) {
  if (PERMANENT_DELETION_ERRORS.has(error?.code)) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'ORDER_DELETE_FAILED',
    message: 'The order could not be permanently deleted. Try again or contact support.',
  }
}

async function retainOrderAsDeleted(orderId, adminUid, { firestore, timestamp }) {
  const orderRef = firestore.collection('orders').doc(orderId)
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef)
    if (!snapshot.exists) {
      throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
    }

    const order = snapshot.data()
    if (order.deletedAt) return { orderId, alreadyDeleted: true }
    assertOrderCanDelete(order)

    const deletedAt = timestamp.now()
    transaction.update(orderRef, {
      archived: true,
      archivedAt: deletedAt,
      archivedBy: adminUid,
      deleted: true,
      deletedAt,
      deletedBy: adminUid,
      deletionRetention: 'financial_audit',
    })
    return { orderId, alreadyDeleted: false }
  })
}

export async function deleteOrders(orderIds, adminUid, {
  firestore = db,
  timestamp = Timestamp,
} = {}) {
  const results = []
  for (const orderId of orderIds) {
    try {
      const result = await retainOrderAsDeleted(orderId, adminUid, { firestore, timestamp })
      results.push({ ...result, success: true })
    } catch (error) {
      results.push({ orderId, success: false, ...getDeletionError(error) })
    }
  }

  const succeeded = results.filter((result) => result.success).map(({ orderId }) => orderId)
  const failed = results.filter((result) => !result.success)
  return { results, succeeded, failed }
}

async function permanentlyDeleteOrder(orderId, adminUid, { firestore, timestamp }) {
  const orderRef = firestore.collection('orders').doc(orderId)
  const auditRef = firestore.collection('orderDeletionAudits').doc(orderId)

  const initialOrder = await orderRef.get()
  if (!initialOrder.exists) {
    const existingAudit = await auditRef.get()
    if (existingAudit.exists) {
      return {
        orderId,
        success: true,
        alreadyDeleted: true,
        financialAuditRetained: true,
        relatedSubcollectionsRemoved: 0,
      }
    }
    throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
  }

  const subcollections = await orderRef.listCollections()
  if (subcollections.length) {
    const names = subcollections.map((collection) => collection.id).join(', ')
    throw Object.assign(
      new Error(`This order has unreviewed subcollections (${names}); no documents were deleted.`),
      { code: 'ORDER_HAS_SUBCOLLECTIONS' },
    )
  }

  return firestore.runTransaction(async (transaction) => {
    const inventoryHistoryQuery = firestore.collection('inventoryHistory')
      .where('orderId', '==', orderId)
    const [orderSnapshot, auditSnapshot, inventoryHistorySnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(auditRef),
      transaction.get(inventoryHistoryQuery),
    ])
    if (!orderSnapshot.exists) {
      if (auditSnapshot.exists) {
        return {
          orderId,
          success: true,
          alreadyDeleted: true,
          financialAuditRetained: true,
          relatedSubcollectionsRemoved: 0,
        }
      }
      throw Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND' })
    }
    if (auditSnapshot.exists) {
      throw Object.assign(new Error('A deletion audit already exists for this order; manual review is required.'), {
        code: 'ORDER_AUDIT_EXISTS',
      })
    }

    const order = orderSnapshot.data()
    assertOrderCanPermanentlyDelete(order)
    assertInventoryHistoryIsReconciled(orderId, order, inventoryHistorySnapshot)
    const deletedAt = timestamp.now()
    transaction.create(auditRef, createFinancialAudit(orderId, order, adminUid, deletedAt))
    transaction.delete(orderRef)
    return {
      orderId,
      success: true,
      alreadyDeleted: false,
      financialAuditRetained: true,
      relatedSubcollectionsRemoved: 0,
    }
  })
}

export async function permanentlyDeleteOrders(orderIds, adminUid, {
  firestore = db,
  timestamp = Timestamp,
} = {}) {
  const results = []
  for (const orderId of orderIds) {
    try {
      results.push(await permanentlyDeleteOrder(orderId, adminUid, { firestore, timestamp }))
    } catch (error) {
      results.push({ orderId, success: false, ...getPermanentDeletionError(error) })
    }
  }

  const succeeded = results.filter((result) => result.success).map(({ orderId }) => orderId)
  const failed = results.filter((result) => !result.success)
  return {
    results,
    succeeded,
    failed,
    permanentlyDeletedCount: results.filter((result) => result.success && !result.alreadyDeleted).length,
    alreadyDeletedCount: results.filter((result) => result.success && result.alreadyDeleted).length,
    rejectedCount: failed.length,
  }
}
