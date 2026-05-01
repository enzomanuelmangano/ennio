/**
 * Checkout Flow Tests
 * Equivalent to maestro-e2e/04-checkout-flow.yaml
 */
import { element, sleep, runTest } from '@tasto/test';
import { goHome, goProducts, goCart, clearCart, loginWithDemo } from './shared';

// ============================================
// SETUP: Login and add items to cart
// ============================================
await goHome();
await loginWithDemo();
await clearCart();

// Add products to cart
await goProducts();
await element('add-to-cart-1').tap();
await element('product-card-2').tap();
await element('product-detail-screen').toBeVisible();
await element('add-to-cart-btn').tap();
await element({ text: 'View Cart' }).tap();

// ============================================
// TEST: Cart shows items before checkout
// ============================================
await runTest('Cart shows items before checkout', async () => {
  await element('cart-screen').toBeVisible();
  await element('cart-item-1').toBeVisible();
  await element('cart-item-2').toBeVisible();
  await element('cart-summary').toBeVisible();
  await element('checkout-btn').toBeVisible();
});

// ============================================
// TEST: Start checkout
// ============================================
await runTest('Start checkout', async () => {
  await element('checkout-btn').tap();
  await element('checkout-screen').toBeVisible();
});

// ============================================
// STEP 1: Shipping Address
// ============================================
await runTest('Fill shipping address', async () => {
  await element('shipping-form').toBeVisible();

  await element('shipping-name').tap();
  await element('shipping-name').typeText('John Doe');

  await element('shipping-street').tap();
  await element('shipping-street').typeText('123 Main Street');

  await element('shipping-city').tap();
  await element('shipping-city').typeText('San Francisco');

  await element('shipping-state').tap();
  await element('shipping-state').typeText('CA');

  await element('shipping-zip').tap();
  await element('shipping-zip').typeText('94105');

  await element('shipping-phone').tap();
  await element('shipping-phone').typeText('415-555-0123');

  await element('next-btn').tap();
});

// ============================================
// STEP 2: Payment Details
// ============================================
await runTest('Fill payment details', async () => {
  await element('payment-form').toBeVisible();

  await element('payment-card-number').tap();
  await element('payment-card-number').typeText('4111111111111111');

  await element('payment-cardholder').tap();
  await element('payment-cardholder').typeText('John Doe');

  await element('payment-expiry').tap();
  await element('payment-expiry').typeText('12/25');

  await element('payment-cvv').tap();
  await element('payment-cvv').typeText('123');

  await element('next-btn').tap();
});

// ============================================
// STEP 3: Order Review
// ============================================
await runTest('Order review shows details', async () => {
  await element('order-review').toBeVisible();
  await element({ text: '123 Main Street' }).toExist();
  await element({ text: '****1111' }).toExist();
  await element('cart-summary').toBeVisible();
});

// ============================================
// TEST: Go back to edit shipping
// ============================================
await runTest('Edit shipping address', async () => {
  await element('back-btn').tap();
  await element('payment-form').toBeVisible();

  await element('back-btn').tap();
  await element('shipping-form').toBeVisible();

  // Edit address
  await element('shipping-street').clearText();
  await element('shipping-street').typeText('456 Oak Avenue');

  // Go forward
  await element('next-btn').tap();
  await element('payment-form').toBeVisible();

  await element('next-btn').tap();
  await element('order-review').toBeVisible();

  // Verify updated
  await element({ text: '456 Oak Avenue' }).toExist();
});

// ============================================
// TEST: Place order
// ============================================
await runTest('Place order', async () => {
  await element('place-order-btn').tap();
  await element({ text: 'Order Placed' }).toExist();
  await element({ text: 'View Orders' }).tap();
});

// ============================================
// TEST: Order appears in orders list
// ============================================
await runTest('Order in orders list', async () => {
  await element('orders-screen').toBeVisible();
  await element('orders-list').toBeVisible();
  await element({ text: 'Processing' }).toExist();
});

// ============================================
// TEST: Cart is now empty
// ============================================
await runTest('Cart is empty after order', async () => {
  await goCart();
  await element('cart-screen-empty').toBeVisible();
});

console.log('\n✅ Checkout flow tests completed!');
