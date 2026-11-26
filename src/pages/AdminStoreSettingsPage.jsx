import { useEffect, useState } from 'react'
import { useToast } from '../hooks/useToast'
import { getStoreSettings, updateStoreWhatsAppNumber } from '../services/storeSettingsService'

export default function AdminStoreSettingsPage() {
  const [whatsappNumber, setWhatsappNumber] = useState('')
  const [configuredNumber, setConfiguredNumber] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const { success, error } = useToast()

  useEffect(() => {
    let active = true
    getStoreSettings()
      .then((settings) => {
        if (active) {
          setWhatsappNumber(settings.whatsappNumber || '')
          setConfiguredNumber(settings.whatsappNumber || '')
        }
      })
      .catch((loadError) => {
        if (active) setErrorMessage(loadError.message || 'Unable to load store settings.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const handleSave = async (event) => {
    event.preventDefault()
    setSaving(true)
    setErrorMessage('')
    try {
      const settings = await updateStoreWhatsAppNumber(whatsappNumber)
      setWhatsappNumber(settings.whatsappNumber || '')
      setConfiguredNumber(settings.whatsappNumber || '')
      success(settings.whatsappNumber ? 'Store WhatsApp number updated.' : 'Store WhatsApp number cleared.')
    } catch (saveError) {
      const message = saveError.message || 'Unable to update the store WhatsApp number.'
      setErrorMessage(message)
      error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-sm text-brand-dusty">
          Set the WhatsApp destination used for optional, post-payment order messages.
        </p>
      </header>

      <form onSubmit={handleSave} className="space-y-5 rounded-2xl border border-brand-rose-gold/30 bg-brand-card-white p-6 shadow-soft">
        <div>
          <label htmlFor="store-whatsapp-number" className="text-sm font-medium text-brand-burgundy">
            Store WhatsApp number
          </label>
          <input
            id="store-whatsapp-number"
            className="input-field mt-2"
            type="tel"
            autoComplete="tel"
            value={whatsappNumber}
            onChange={(event) => setWhatsappNumber(event.target.value)}
            placeholder="+919876543210"
            disabled={loading || saving}
            aria-describedby="store-whatsapp-help"
          />
          <p id="store-whatsapp-help" className="mt-2 text-xs text-brand-dusty">
            Use international format (E.164), for example +919876543210. A 10-digit number is treated as India (+91). Leave blank to disable WhatsApp order links.
          </p>
        </div>
        {loading && <p className="text-sm text-brand-dusty">Loading current store contact...</p>}
        {errorMessage && <p className="text-sm text-red-700" role="alert">{errorMessage}</p>}
        {!loading && !errorMessage && (
          <p className="text-sm text-brand-dusty" role="status">
            Current configured number: {configuredNumber || 'Not configured'}
          </p>
        )}
        <button type="submit" className="btn-gold disabled:opacity-50" disabled={loading || saving}>
          {saving ? 'Saving...' : 'Save WhatsApp number'}
        </button>
      </form>
    </section>
  )
}
