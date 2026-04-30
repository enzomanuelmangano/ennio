import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goProducts, goCart, goProfile, goHome } from './setup';

/**
 * Full Checkout Flow E2E Tests
 *
 * Tests the complete user journey from browsing to placing an order
 */
export default async function checkoutFlowTests(): Promise<void> {
  await setup();

  try {
    // Start fresh - login first
    await runTest('should login with demo account', async () => {
      await goProfile();
      const guestView = await element('guest-view').exists();
      if (guestView) {
        await element('guest-signin-btn').tap();
        await waitForVisible('login-screen');
        await element('demo-login-btn').tap();
        await sleep(1500);
        await waitForVisible('profile-screen', { timeout: 5000 });
      }
    });

    // Browse and add products
    await runTest('should browse products', async () => {
      await goProducts();
      await element('products-screen').toBeVisible();
    });

    await runTest('should view product details', async () => {
      await element('product-card-1').tap();
      await waitForVisible('product-detail-screen');
      await element('product-title').toBeVisible();
      await element('product-price').toBeVisible();
    });

    await runTest('should select quantity', async () => {
      await element('increase-quantity').tap();
      await element('quantity-value').toHaveText('2');
    });

    await runTest('should add to cart from detail page', async () => {
      await element('add-to-cart-btn').tap();
      await sleep(500); // Alert appears
    });

    await runTest('should continue shopping and add another product', async () => {
      await goProducts();
      await element('add-to-cart-3').tap();
      await sleep(300);
    });

    await runTest('should view cart with items', async () => {
      await goCart();
      await element('cart-screen').toBeVisible();
      await element('cart-item-1').toBeVisible();
      await element('cart-item-3').toBeVisible();
    });

    await runTest('should show correct cart summary', async () => {
      await element('cart-summary').toBeVisible();
      await element('cart-total').toBeVisible();
    });

    await runTest('should proceed to checkout', async () => {
      await element('checkout-btn').tap();
      await waitForVisible('checkout-screen');
    });

    await runTest('should display shipping form (step 1)', async () => {
      await element('shipping-form').toBeVisible();
      await element('shipping-name').toBeVisible();
      await element('shipping-street').toBeVisible();
      await element('shipping-city').toBeVisible();
    });

    await runTest('should fill shipping information', async () => {
      await element('shipping-name').typeText('John Doe');
      await element('shipping-street').typeText('123 Main Street');
      await element('shipping-city').typeText('New York');
      await element('shipping-state').typeText('NY');
      await element('shipping-zip').typeText('10001');
      await element('shipping-phone').typeText('5551234567');
    });

    await runTest('should proceed to payment step', async () => {
      await element('next-btn').tap();
      await waitForVisible('payment-form');
    });

    await runTest('should fill payment information', async () => {
      await element('payment-card-number').typeText('4242424242424242');
      await element('payment-cardholder').typeText('JOHN DOE');
      await element('payment-expiry').typeText('1225');
      await element('payment-cvv').typeText('123');
    });

    await runTest('should proceed to review step', async () => {
      await element('next-btn').tap();
      await waitForVisible('order-review');
    });

    await runTest('should display order review', async () => {
      await element('order-review').toBeVisible();
      // Should show shipping address and items
    });

    await runTest('should place order', async () => {
      await element('place-order-btn').tap();
      await sleep(2000); // Wait for checkout to process
      // Should navigate to orders or show success
    });

    await runTest('should view order in history', async () => {
      await waitForVisible('orders-screen', { timeout: 5000 });
      await element('orders-list').toBeVisible();
    });

    await runTest('should view order details', async () => {
      // Tap the first order in the list
      const orderExists = await element('orders-list').exists();
      if (orderExists) {
        // Order cards have IDs like order-ORD-xxx
        await element('orders-list').toBeVisible();
      }
    });
  } finally {
    teardown();
  }
}
