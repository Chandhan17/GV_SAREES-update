import { useCallback, useEffect, useState } from 'react'
import { fetchBestSellerProductIds } from '../services/bestSellerService'

export function useBestSellers(enabled = true) {
  const [productIds, setProductIds] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadBestSellers = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      setProductIds(await fetchBestSellerProductIds({ forceRefresh }))
    } catch (loadError) {
      setError(loadError?.message || 'Unable to load best sellers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) {
      loadBestSellers()
    } else {
      setLoading(false)
    }
  }, [enabled, loadBestSellers])

  return {
    productIds,
    loading,
    error,
    reload: () => loadBestSellers(true),
  }
}
