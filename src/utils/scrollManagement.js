export function getScrollAction({
  isInitialNavigation,
  navigationType,
  pathnameChanged,
  isFilteredProductsRoute,
  hasSavedPosition,
}) {
  if (isInitialNavigation) return isFilteredProductsRoute ? 'results' : 'top'
  if (navigationType === 'POP') {
    if (hasSavedPosition) return 'restore'
    return isFilteredProductsRoute ? 'results' : 'top'
  }
  if (pathnameChanged) return isFilteredProductsRoute ? 'results' : 'top'
  return 'none'
}

export function shouldScrollAfterFilterNavigation({
  pathname,
  previousSearch,
  currentSearch,
  navigationType,
  isEditingTextFilter,
}) {
  return pathname === '/products'
    && previousSearch !== currentSearch
    && navigationType !== 'POP'
    && !isEditingTextFilter
}

export function getProductResultsScrollTop({ scrollY, targetTop, headerHeight, gap = 16 }) {
  return Math.max(0, scrollY + targetTop - headerHeight - gap)
}

export function scrollToProductResults() {
  const target = document.querySelector('[data-scroll-results]')
  if (!target) return false

  const headerHeight = document.querySelector('header')?.getBoundingClientRect().height || 0
  const top = getProductResultsScrollTop({
    scrollY: window.scrollY,
    targetTop: target.getBoundingClientRect().top,
    headerHeight,
  })
  window.scrollTo({ top, behavior: 'instant' })
  return true
}
