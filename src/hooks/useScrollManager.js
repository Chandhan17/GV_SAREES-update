import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { getScrollAction, scrollToProductResults } from '../utils/scrollManagement'

function getSavedScrollPosition(positions, key) {
  return positions.get(key)
}

function saveScrollPosition(positions, key) {
  positions.set(key, { left: window.scrollX, top: window.scrollY })
}

export default function useScrollManager() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const currentLocationRef = useRef(location)
  const previousLocationRef = useRef(null)
  const scrollPositionsRef = useRef(new Map())
  const animationFrameRef = useRef(0)
  const isAdminRoute = location.pathname.startsWith('/admin') || location.pathname === '/login'

  useLayoutEffect(() => {
    const previousRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = isAdminRoute ? 'auto' : 'manual'
    return () => {
      window.history.scrollRestoration = previousRestoration
    }
  }, [isAdminRoute])

  useLayoutEffect(() => {
    const saveCurrentPosition = () => {
      saveScrollPosition(scrollPositionsRef.current, currentLocationRef.current.key)
    }
    window.addEventListener('scroll', saveCurrentPosition, { passive: true })
    window.addEventListener('pagehide', saveCurrentPosition)
    return () => {
      window.removeEventListener('scroll', saveCurrentPosition)
      window.removeEventListener('pagehide', saveCurrentPosition)
    }
  }, [])

  useLayoutEffect(() => {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = 0
    }

    const currentLocation = { key: location.key, pathname: location.pathname }
    const previousLocation = previousLocationRef.current
    const isInitialNavigation = !previousLocation
    if (previousLocation) {
      saveScrollPosition(scrollPositionsRef.current, previousLocation.key)
    }

    const savedPosition = getSavedScrollPosition(scrollPositionsRef.current, location.key)
    const isFilteredProductsRoute = location.pathname === '/products' && Boolean(location.search)
    const action = isAdminRoute ? 'none' : getScrollAction({
      isInitialNavigation,
      navigationType,
      pathnameChanged: Boolean(previousLocation && previousLocation.pathname !== location.pathname),
      isFilteredProductsRoute,
      hasSavedPosition: Boolean(savedPosition),
    })

    if (action === 'top') {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
    } else if (action === 'restore' && savedPosition) {
      window.scrollTo({ left: savedPosition.left, top: savedPosition.top, behavior: 'instant' })
    } else if (action === 'results') {
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = 0
        scrollToProductResults()
      })
    }

    previousLocationRef.current = currentLocation
    currentLocationRef.current = currentLocation
  }, [location.key, location.pathname, location.search, navigationType, isAdminRoute])

  useLayoutEffect(() => () => {
    if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current)
  }, [])
}
