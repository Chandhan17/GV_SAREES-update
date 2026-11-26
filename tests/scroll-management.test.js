import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getProductResultsScrollTop,
  getScrollAction,
  shouldScrollAfterFilterNavigation,
} from '../src/utils/scrollManagement.js'

test('new routes reset to the top while filtered product routes focus results', () => {
  assert.equal(getScrollAction({
    isInitialNavigation: true,
    isFilteredProductsRoute: false,
  }), 'top')
  assert.equal(getScrollAction({
    isInitialNavigation: false,
    navigationType: 'PUSH',
    pathnameChanged: true,
    isFilteredProductsRoute: false,
  }), 'top')
  assert.equal(getScrollAction({
    isInitialNavigation: false,
    navigationType: 'PUSH',
    pathnameChanged: true,
    isFilteredProductsRoute: true,
  }), 'results')
})

test('back and forward navigation restores saved positions and uses a safe fallback', () => {
  assert.equal(getScrollAction({
    isInitialNavigation: false,
    navigationType: 'POP',
    pathnameChanged: true,
    isFilteredProductsRoute: false,
    hasSavedPosition: true,
  }), 'restore')
  assert.equal(getScrollAction({
    isInitialNavigation: false,
    navigationType: 'POP',
    pathnameChanged: true,
    isFilteredProductsRoute: true,
    hasSavedPosition: false,
  }), 'results')
})

test('product filter navigation scrolls only after non-typing URL changes', () => {
  const navigation = {
    pathname: '/products',
    previousSearch: '?search=sar',
    currentSearch: '?search=saree',
    navigationType: 'PUSH',
    isEditingTextFilter: false,
  }
  assert.equal(shouldScrollAfterFilterNavigation(navigation), true)
  assert.equal(shouldScrollAfterFilterNavigation({ ...navigation, isEditingTextFilter: true }), false)
  assert.equal(shouldScrollAfterFilterNavigation({ ...navigation, navigationType: 'POP' }), false)
  assert.equal(shouldScrollAfterFilterNavigation({ ...navigation, pathname: '/cart' }), false)
})

test('results offset accounts for the header and never scrolls above the document', () => {
  assert.equal(getProductResultsScrollTop({
    scrollY: 900,
    targetTop: -650,
    headerHeight: 120,
    gap: 16,
  }), 114)
  assert.equal(getProductResultsScrollTop({
    scrollY: 0,
    targetTop: 40,
    headerHeight: 100,
    gap: 16,
  }), 0)
})
