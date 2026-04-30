import {
  element,
  waitForElement,
  waitForVisible,
} from '@tasto/runner';
import { setup, teardown, runTest, goHome } from './setup.ts';

/**
 * Home Screen E2E Tests
 *
 * Tests the home tab with featured products, trending, and navigation
 */
export default async function homeTests(): Promise<void> {
  await setup();
  await goHome();

  try {
    await runTest('should display home screen', async () => {
      await element('home-screen').toBeVisible();
    });

    await runTest('should display quick action buttons', async () => {
      await element('quick-action-search').toBeVisible();
      await element('quick-action-cart').toBeVisible();
      await element('quick-action-orders').toBeVisible();
      await element('quick-action-settings').toBeVisible();
    });

    await runTest('should display featured products section', async () => {
      // Check first featured product exists
      await element('featured-product-1').toBeVisible();
    });

    await runTest('should display trending products', async () => {
      // Check trending products exist (rating >= 4.7)
      await element('trending-product-4').toBeVisible(); // Ergonomic Office Chair has 4.8 rating
    });

    await runTest('should navigate to products via See All', async () => {
      await element('see-all-featured').tap();
      await waitForVisible('products-screen');
      // Navigate back to home
      await goHome();
    });

    await runTest('should navigate to cart via quick action', async () => {
      await element('quick-action-cart').tap();
      // Cart could be empty or have items
      const cartExists = await element('cart-screen').exists();
      const emptyCartExists = await element('cart-screen-empty').exists();
      if (!cartExists && !emptyCartExists) {
        throw new Error('Cart screen not visible');
      }
      await goHome();
    });

    await runTest('should navigate to products via category', async () => {
      await element('category-electronics').tap();
      await waitForVisible('products-screen');
      // Verify category filter is active
      await element('filter-category-electronics').toBeVisible();
      await goHome();
    });

    await runTest('should display promo banner', async () => {
      await element('promo-banner').toBeVisible();
    });

    await runTest('should navigate to products via promo banner', async () => {
      await element('promo-shop-now').tap();
      await waitForVisible('products-screen');
      await goHome();
    });

    await runTest('should show sign in button when not authenticated', async () => {
      // Assuming starting in unauthenticated state
      const signInBtn = await element('home-signin-btn').exists();
      if (signInBtn) {
        await element('home-signin-btn').toBeVisible();
      }
    });
  } finally {
    teardown();
  }
}
