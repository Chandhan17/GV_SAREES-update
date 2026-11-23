import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { db } from './firebase'
import { getIdToken } from './authService'

const ordersCollection = collection(db, 'orders')

function normalizeOrder(snapshot) {
  const data = snapshot.data()

  return {
    id: snapshot.id,
    ...data,
    createdAt: data.createdAt?.toDate?.() || null,
    expiresAt: data.expiresAt?.toDate?.() || null,
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
