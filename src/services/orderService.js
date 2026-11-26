import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { db } from './firebase'
import { getIdToken } from './authService'
import { getOrderDate } from '../utils/orderDate'

const ordersCollection = collection(db, 'orders')

function normalizeOrder(snapshot) {
  const data = snapshot.data()

  return {
    id: snapshot.id,
    ...data,
    createdAt: getOrderDate(data.createdAt),
    expiresAt: getOrderDate(data.expiresAt),
  }
}

export async function getOrders() {
  const ordersQuery = query(ordersCollection, orderBy('createdAt', 'desc'))
  const snapshot = await getDocs(ordersQuery)
  return snapshot.docs.map(normalizeOrder)
}

export async function updateOrder(orderId, updates) {
  const token = await getIdToken()
  const response = await fetch('/api/admin/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: 'status', orderId, orderStatus: updates.orderStatus }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to update order.')
  return body
}

export async function archiveOrder(orderId) {
  const token = await getIdToken()
  const response = await fetch('/api/admin/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: 'archive', orderId }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to archive order.')
  return body
}

export async function deleteOrders(orderIds) {
  const token = await getIdToken()
  const results = []
  for (let offset = 0; offset < orderIds.length; offset += 100) {
    const batch = orderIds.slice(offset, offset + 100)
    try {
      const response = await fetch('/api/admin/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action: 'delete', orderIds: batch }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message || 'Unable to delete orders.')
      if (!Array.isArray(body.results) || body.results.length !== batch.length) {
        throw new Error('The server returned an incomplete deletion result.')
      }
      results.push(...body.results)
    } catch (requestError) {
      results.push(...batch.map((orderId) => ({
        orderId,
        success: false,
        message: requestError.message || 'Unable to delete this order.',
      })))
    }
  }
  return {
    results,
    succeeded: results.filter((result) => result.success).map(({ orderId }) => orderId),
    failed: results.filter((result) => !result.success),
  }
}

export async function permanentlyDeleteOrders(orderIds, backupDisposition) {
  const token = await getIdToken()
  const results = []
  for (let offset = 0; offset < orderIds.length; offset += 100) {
    const batch = orderIds.slice(offset, offset + 100)
    try {
      const response = await fetch('/api/admin/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'permanent-delete',
          orderIds: batch,
          backupDisposition,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message || 'Unable to permanently delete orders.')
      if (!Array.isArray(body.results) || body.results.length !== batch.length) {
        throw new Error('The server returned an incomplete permanent-deletion result.')
      }
      results.push(...body.results)
    } catch (requestError) {
      results.push(...batch.map((orderId) => ({
        orderId,
        success: false,
        code: 'ORDER_DELETE_FAILED',
        message: requestError.message || 'Unable to permanently delete this order.',
      })))
    }
  }
  return {
    results,
    succeeded: results.filter((result) => result.success).map(({ orderId }) => orderId),
    failed: results.filter((result) => !result.success),
    permanentlyDeletedCount: results.filter((result) => result.success && !result.alreadyDeleted).length,
    alreadyDeletedCount: results.filter((result) => result.success && result.alreadyDeleted).length,
    rejectedCount: results.filter((result) => !result.success).length,
  }
}

export function subscribeOrders(onNext, onError) {
  const ordersQuery = query(ordersCollection, orderBy('createdAt', 'desc'))

  return onSnapshot(
    ordersQuery,
    (snapshot) => {
      onNext(snapshot.docs.map(normalizeOrder))
    },
    onError,
  )
}
