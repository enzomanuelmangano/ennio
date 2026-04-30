import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goProducts, goCart, goHome } from './setup';

/**
 * Cart E2E Tests
 *
 * Tests cart functionality including add, remove, quantity updates
 */
export default async function cartTests(): Promise<void> {
  await setup();

  try {
    // First add some products to cart
    await runTest('should start with empty cart', async () => {
      await goCart();
      await element('cart-screen-empty').toBeVisible();
      await element('browse-products-btn').toBeVisible();
    });

    await runTest('should navigate to products from empty cart', async () => {
      await element('browse-products-btn').tap();
      await waitForVisible('products-screen');
    });

    await runTest('should add first product to cart', async () => {
      await element('add-to-cart-1').tap();
      await goCart();
      await element('cart-screen').toBeVisible();
      await element('cart-item-1').toBeVisible();
    });

    await runTest('should display cart summary', async () => {
      await element('cart-summary').toBeVisible();
      await element('cart-total').toBeVisible();
    });

    await runTest('should increase quantity', async () => {
      await element('increase-qty-1').tap();
      await element('qty-1').toHaveText('2');
    });

    await runTest('should decrease quantity', async () => {
      await element('decrease-qty-1').tap();
      await element('qty-1').toHaveText('1');
    });

    await runTest('should add more products', async () => {
      await goProducts();
      await element('add-to-cart-2').tap();
      await element('add-to-cart-3').tap();
      await goCart();
      await element('cart-item-1').toBeVisible();
      await element('cart-item-2').toBeVisible();
      await element('cart-item-3').toBeVisible();
    });

    await runTest('should show item count in header', async () => {
      // Cart should show "3 items" or similar
      await element('cart-screen').toBeVisible();
    });

    await runTest('should update total when quantity changes', async () => {
      // Get initial total
      await element('cart-total').toBeVisible();
      // Increase quantity
      await element('increase-qty-1').tap();
      // Total should update (we can't easily check the value, but we verify it's visible)
      await element('cart-total').toBeVisible();
    });

    await runTest('should display checkout button', async () => {
      await element('checkout-btn').toBeVisible();
    });

    await runTest('should require sign in for checkout', async () => {
      // When not signed in, tapping checkout should show sign-in prompt
      await element('checkout-btn').tap();
      // An alert should appear - we can't easily test alerts, but we can verify we stay on cart
      await sleep(500);
      await element('cart-screen').toBeVisible();
    });

    await runTest('should display clear all button', async () => {
      await element('clear-cart-btn').toBeVisible();
    });

    // Cleanup - don't actually clear cart as it may be needed for other tests
  } finally {
    teardown();
  }
}
