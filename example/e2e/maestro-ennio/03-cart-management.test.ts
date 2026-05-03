/**
 * Cart Management Tests
 * Equivalent to maestro-e2e/03-cart-management.yaml
 */
import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProducts, goCart, clearCart } from './shared';

// ============================================
// SETUP: Clear any existing cart items
// ============================================
await clearCart();

// ============================================
// TEST: Empty cart state
// ============================================
await runTest('Empty cart state', async () => {
  await element('cart-screen-empty').toBeVisible();
  await element({ text: 'Your cart is empty' }).toExist();
  await element('browse-products-btn').toBeVisible();
});

// ============================================
// TEST: Navigate to products from empty cart
// ============================================
await runTest('Navigate to products from empty cart', async () => {
  await element('browse-products-btn').tap();
  await element('products-screen').toBeVisible();
});

// ============================================
// TEST: Add product to cart from products list
// ============================================
await runTest('Add product from products list', async () => {
  await element('add-to-cart-1').tap();
  await goCart();
  await element('cart-screen').toBeVisible();
  await element('cart-item-1').toBeVisible();
});

// ============================================
// TEST: Add product from product detail
// ============================================
await runTest('Add product from product detail', async () => {
  await goProducts();
  await element('product-card-2').tap();
  await element('product-detail-screen').toBeVisible();

  // Increase quantity before adding
  await element('increase-quantity').tap();
  await element('increase-quantity').tap();
  await element('add-to-cart-btn').tap();

  await element({ text: 'Added to Cart' }).toExist();
  await element({ text: 'View Cart' }).tap();
});

// ============================================
// TEST: Cart has multiple items
// ============================================
await runTest('Cart has multiple items', async () => {
  await element('cart-screen').toBeVisible();
  await element('cart-item-1').toBeVisible();
  await element('cart-item-2').toBeVisible();
});

// ============================================
// TEST: Update quantity in cart
// ============================================
await runTest('Update quantity in cart', async () => {
  await element('increase-qty-1').tap();
  await element('qty-1').toBeVisible();
  await element('decrease-qty-1').tap();
});

// ============================================
// TEST: Cart summary updates
// ============================================
await runTest('Cart summary visible', async () => {
  await element('cart-summary').toBeVisible();
  await element('cart-total').toBeVisible();
});

// ============================================
// TEST: Remove single item
// ============================================
await runTest('Remove single item', async () => {
  await element('remove-item-2').tap();
  await sleep(500);
  const item2Exists = await element('cart-item-2').exists();
  if (item2Exists) {
    throw new Error('Item 2 should be removed');
  }
  await element('cart-item-1').toBeVisible();
});

// ============================================
// TEST: Add more items from home featured
// ============================================
await runTest('Add from home featured', async () => {
  await goHome();
  await element('add-to-cart-featured-3').tap();
  await goCart();
  await element('cart-item-3').toBeVisible();
});

// ============================================
// TEST: Clear entire cart
// ============================================
await runTest('Clear entire cart', async () => {
  await element('clear-cart-btn').tap();
  await element({ text: 'Clear Cart' }).toExist();
  await element({ text: 'Clear' }).tap();
  await element('cart-screen-empty').toBeVisible();
});

// ============================================
// TEST: Add from trending products
// ============================================
await runTest('Add from trending products', async () => {
  await goHome();
  await element('trending-product-4').tap();
  await element('product-detail-screen').toBeVisible();
  await element('add-to-cart-btn').tap();
  await element({ text: 'View Cart' }).tap();
  await element('cart-item-4').toBeVisible();
});

// ============================================
// TEST: Checkout button visible
// ============================================
await runTest('Checkout button visible', async () => {
  await element('checkout-btn').toBeVisible();
});

console.log('\n✅ Cart management tests completed!');
