import { useCallback, useMemo, useRef, useState } from 'react'
import CartContext from './cart-context'
import {
  addCartProduct,
  clearCartItems,
  createBuyNowCartItem,
  getCartItemCount,
  getCartSubtotal,
  readBuyNowItem,
  readCartItems,
  removeCartProduct,
  setCartProductQuantity,
  writeBuyNowItem,
  writeCartItems,
} from '../utils/cart'

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => readCartItems(window.localStorage))
  const itemsRef = useRef(items)
  const [buyNowItem, setBuyNowItem] = useState(() => readBuyNowItem(window.localStorage))
  const buyNowItemRef = useRef(buyNowItem)

  const commitItems = useCallback((nextItems) => {
    writeCartItems(nextItems, window.localStorage)
    itemsRef.current = nextItems
    setItems(nextItems)
  }, [])

  const addToCart = useCallback((product, quantity = 1) => {
    const nextItems = addCartProduct(itemsRef.current, product, quantity)
    commitItems(nextItems)
  }, [commitItems])

  const commitBuyNowItem = useCallback((item) => {
    writeBuyNowItem(item, window.localStorage)
    buyNowItemRef.current = item
    setBuyNowItem(item)
  }, [])

  const startBuyNow = useCallback((product, quantity = 1) => {
    const item = createBuyNowCartItem(product, quantity)
    commitBuyNowItem(item)
    return item
  }, [commitBuyNowItem])

  const setBuyNowQuantity = useCallback((productId, quantity, availableStock) => {
    const currentItem = buyNowItemRef.current
    if (!currentItem || currentItem.id !== productId) return
    const [updatedItem] = setCartProductQuantity([currentItem], productId, quantity, availableStock)
    commitBuyNowItem(updatedItem)
  }, [commitBuyNowItem])

  const clearBuyNow = useCallback(() => {
    commitBuyNowItem(null)
  }, [commitBuyNowItem])

  const setQuantity = useCallback((productId, quantity, availableStock) => {
    commitItems(setCartProductQuantity(itemsRef.current, productId, quantity, availableStock))
  }, [commitItems])

  const removeFromCart = useCallback((productId) => {
    commitItems(removeCartProduct(itemsRef.current, productId))
  }, [commitItems])

  const clearCart = useCallback(() => {
    commitItems(clearCartItems())
  }, [commitItems])

  const value = useMemo(() => ({
    items,
    itemCount: getCartItemCount(items),
    subtotal: getCartSubtotal(items),
    addToCart,
    buyNowItem,
    startBuyNow,
    setBuyNowQuantity,
    clearBuyNow,
    setQuantity,
    removeFromCart,
    clearCart,
  }), [items, buyNowItem, addToCart, startBuyNow, setBuyNowQuantity, clearBuyNow, setQuantity, removeFromCart, clearCart])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
