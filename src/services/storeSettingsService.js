import { getIdToken } from './authService'

export async function getStoreSettings() {
  const response = await fetch('/api/admin/settings')
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to load store contact settings.')
  return body.settings
}

export async function updateStoreWhatsAppNumber(whatsappNumber) {
  const token = await getIdToken()
  const response = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ whatsappNumber }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || 'Unable to update the store WhatsApp number.')
  return body.settings
}
