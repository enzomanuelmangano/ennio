/**
 * Full End-to-End Purchase Flow Tests
 * Equivalent to maestro-e2e/10-full-purchase-flow.yaml
 * Complete journey from browse to order delivery
 */
import { element, sleep, runTest } from '@ennio/test';
import {
  goHome,
  goProducts,
  goCart,
  goProfile,
  clearCart,
  ensureLoggedOut,
} from './shared';

// ============================================
// PHASE 1: Fresh Start
// ============================================
await goHome();
await ensureLoggedOut();
await goHome();
await clearCart();

// ============================================
// PHASE 2: Browse as Guest
// ============================================
await runTest('Browse featured products as guest', async () => {
  await goHome();
  await element('featured-product-1').toBeVisible();
});

await runTest('Navigate via category', async () => {
  await element('category-electronics').tap();
  await element('products-screen').toBeVisible();
});

await runTest('Search for specific product', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('Wireless');
  await element({ text: 'Wireless' }).toExist();
});

// ============================================
// PHASE 3: Add Multiple Products to Cart
// ============================================
await runTest('Add first search result', async () => {
  await element('product-card-1').tap();
  await element('product-detail-screen').toBeVisible();
  await element('product-title').toBeVisible();
  await element('product-price').toBeVisible();
});

await runTest('View description tab', async () => {
  await element('tab-description').tap();
  await element('product-description').toBeVisible();
});

await runTest('Add item with quantity 2', async () => {
  await element('increase-quantity').tap();
  await element('add-to-cart-btn').tap();
  await element({ text: 'Continue Shopping' }).tap();
});

await runTest('Add another product from grid', async () => {
  await goProducts();
  await element('clear-search').tap();
  await element('filter-category-sports').tap();
  await element('add-to-cart-1').tap();
});

// ============================================
// PHASE 4: Review Cart
// ============================================
await runTest('Review cart', async () => {
  await goCart();
  await element('cart-screen').toBeVisible();
  await element('cart-items-list').toBeVisible();
  await element('cart-summary').toBeVisible();
  await element('cart-total').toBeVisible();
});

await runTest('Adjust quantity in cart', async () => {
  await element('increase-qty-1').tap();
  await element('decrease-qty-1').tap();
});

// ============================================
// PHASE 5: Attempt Checkout as Guest
// ============================================
await runTest('Guest checkout prompts sign in', async () => {
  await element('checkout-btn').tap();
  await element({ text: 'Sign In' }).toExist();
  await element({ text: 'Sign In' }).tap();
});

// ============================================
// PHASE 6: Registration Flow
// ============================================
await runTest('Navigate to register', async () => {
  await element('login-screen').toBeVisible();
  await element('go-to-register').tap();
  await element('register-screen').toBeVisible();
});

await runTest('Complete registration', async () => {
  await element('name-input').tap();
  await element('name-input').typeText('Jane Smith');

  await element('email-input').tap();
  await element('email-input').typeText('jane.smith@example.com');

  await element('password-input').tap();
  await element('password-input').typeText('securepass123');

  await element('confirm-password-input').tap();
  await element('confirm-password-input').typeText('securepass123');

  await element('accept-terms').tap();
  await element('register-btn').tap();
  await element('home-screen').toBeVisible();
});

// ============================================
// PHASE 7: Cart Still Has Items
// ============================================
await runTest('Cart preserved after login', async () => {
  await goCart();
  await element('cart-screen').toBeVisible();
  await element('cart-items-list').toBeVisible();
});

// ============================================
// PHASE 8: Complete Checkout
// ============================================
await runTest('Start checkout', async () => {
  await element('checkout-btn').tap();
  await element('checkout-screen').toBeVisible();
});

await runTest('Fill shipping form', async () => {
  await element('shipping-form').toBeVisible();

  await element('shipping-name').tap();
  await element('shipping-name').typeText('Jane Smith');

  await element('shipping-street').tap();
  await element('shipping-street').typeText('789 Pine Street');

  await element('shipping-city').tap();
  await element('shipping-city').typeText('Los Angeles');

  await element('shipping-state').tap();
  await element('shipping-state').typeText('CA');

  await element('shipping-zip').tap();
  await element('shipping-zip').typeText('90001');

  await element('shipping-phone').tap();
  await element('shipping-phone').typeText('310-555-0199');

  await element('next-btn').tap();
});

await runTest('Fill payment form', async () => {
  await element('payment-form').toBeVisible();

  await element('payment-card-number').tap();
  await element('payment-card-number').typeText('5555555555554444');

  await element('payment-cardholder').tap();
  await element('payment-cardholder').typeText('Jane Smith');

  await element('payment-expiry').tap();
  await element('payment-expiry').typeText('06/27');

  await element('payment-cvv').tap();
  await element('payment-cvv').typeText('321');

  await element('next-btn').tap();
});

await runTest('Review and place order', async () => {
  await element('order-review').toBeVisible();
  await element({ text: '789 Pine Street' }).toExist();
  await element({ text: '****4444' }).toExist();
  await element('place-order-btn').tap();
});

// ============================================
// PHASE 9: Order Confirmation
// ============================================
await runTest('Order confirmation', async () => {
  await element({ text: 'Order Placed' }).toExist();
  await element({ text: 'View Orders' }).tap();
});

// ============================================
// PHASE 10: Verify Order in History
// ============================================
await runTest('Order in history', async () => {
  await element('orders-screen').toBeVisible();
  await element('orders-list').toBeVisible();
  await element({ text: 'Processing' }).toExist();
});

await runTest('View order details', async () => {
  await element({
    below: { text: 'Order' },
    index: 0,
  }).tap();

  await element('order-details').toBeVisible();
  await element({ text: '789 Pine Street' }).toExist();
  await element('close-details').tap();
});

// ============================================
// PHASE 11: Cart is Empty
// ============================================
await runTest('Cart is empty after order', async () => {
  await goCart();
  await element('cart-screen-empty').toBeVisible();
});

// ============================================
// PHASE 12: Continue Shopping
// ============================================
await runTest('Continue shopping', async () => {
  await element('browse-products-btn').tap();
  await element('products-screen').toBeVisible();
});

// ============================================
// PHASE 13: Quick Reorder Flow
// ============================================
await runTest('Quick reorder flow', async () => {
  await goHome();
  await element('add-to-cart-featured-2').tap();
  await goCart();
  await element('cart-screen').toBeVisible();

  // Clear for next test
  await element('clear-cart-btn').tap();
  await element({ text: 'Clear' }).tap();
});

// ============================================
// PHASE 14: Verify User Stats Updated
// ============================================
await runTest('User stats updated', async () => {
  await element('tab-profile').tap();
  await element('profile-screen').toBeVisible();
  await element('stats-card').toBeVisible();
});

// ============================================
// CLEANUP: Logout
// ============================================
await runTest('Cleanup - logout', async () => {
  await element('menu-logout').tap();
  await element({ text: 'Sign Out' }).tap();
  await element('guest-view').toBeVisible();
});

console.log('\n✅ Full purchase flow tests completed!');
