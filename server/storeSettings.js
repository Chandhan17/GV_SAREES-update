import { getFirestore } from 'firebase-admin/firestore'
import './firebaseAdmin.js'

const db = getFirestore()
const STORE_SETTINGS_PATH = ['settings', 'store']

export function normalizeStoreWhatsAppNumber(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return ''

  const digits = trimmed.replace(/[\s().-]/g, '')
  let international
  if (digits.startsWith('+')) {
    international = digits
  } else if (/^\d{10}$/.test(digits)) {
    if (!/^[6-9]\d{9}$/.test(digits)) return null
    international = `+91${digits}`
  } else {
    international = `+${digits}`
  }

  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null
}

export async function getStoreSettings(firestore = db) {
  const snapshot = await firestore.collection(STORE_SETTINGS_PATH[0]).doc(STORE_SETTINGS_PATH[1]).get()
  const data = snapshot.exists ? snapshot.data() : {}
  const whatsappNumber = normalizeStoreWhatsAppNumber(data.whatsappNumber)
  return { whatsappNumber: whatsappNumber || '' }
}

export async function updateStoreWhatsAppNumber(whatsappNumber, firestore = db) {
  const normalized = normalizeStoreWhatsAppNumber(whatsappNumber)
  if (normalized === null) {
    throw Object.assign(new Error('Enter a valid phone number in international format, such as +919876543210.'), {
      code: 'INVALID_STORE_WHATSAPP_NUMBER',
    })
  }

  await firestore.collection(STORE_SETTINGS_PATH[0]).doc(STORE_SETTINGS_PATH[1]).set({
    whatsappNumber: normalized,
    updatedAt: new Date(),
  }, { merge: true })
  return { whatsappNumber: normalized }
}
