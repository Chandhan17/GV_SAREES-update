export function selectAvailableBestSellers(productIds, products, limit = 6) {
  const productsById = new Map(products.map((product) => [product.id, product]))
  return productIds
    .map((productId) => productsById.get(productId))
    .filter((product) => (
      product
      && product.availableStock > 0
      && product.deleted !== true
      && product.archived !== true
    ))
    .slice(0, limit)
}

export function shouldShowBestSellers({
  productsLoading,
  bestSellersLoading,
  error,
  productCount,
}) {
  return productsLoading || bestSellersLoading || Boolean(error) || productCount > 0
}
