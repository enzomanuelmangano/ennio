import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goProducts, goHome, goCart } from './setup';

/**
 * Products Screen E2E Tests
 *
 * Tests product listing, search, filters, and add to cart
 */
export default async function productsTests(): Promise<void> {
  await setup();
  await goProducts();

  try {
    await runTest('should display products screen', async () => {
      await element('products-screen').toBeVisible();
    });

    await runTest('should display search input', async () => {
      await element('search-input').toBeVisible();
    });

    await runTest('should display category filters', async () => {
      await element('filter-category-all').toBeVisible();
      await element('filter-category-electronics').toBeVisible();
      await element('filter-category-sports').toBeVisible();
    });

    await runTest('should display products list', async () => {
      await element('products-list').toBeVisible();
      // Check first product card exists
      await element('product-card-1').toBeVisible();
    });

    await runTest('should filter by category - Electronics', async () => {
      await element('filter-category-electronics').tap();
      // Check electronics products are shown
      await element('product-card-1').toBeVisible(); // Wireless Headphones
      // Yoga Mat (product 5, Sports) should not be visible in first results
    });

    await runTest('should filter by category - Sports', async () => {
      await element('filter-category-sports').tap();
      // Check sports products are shown
      await element('product-card-5').toBeVisible(); // Yoga Mat
    });

    await runTest('should reset to All categories', async () => {
      await element('filter-category-all').tap();
      await element('product-card-1').toBeVisible();
    });

    await runTest('should search for products', async () => {
      await element('search-input').typeText('headphones');
      await sleep(300); // Wait for search to filter
      await element('product-card-1').toBeVisible(); // Wireless Headphones
    });

    await runTest('should clear search', async () => {
      await element('clear-search').tap();
      // Should show all products again
      await element('product-card-1').toBeVisible();
      await element('product-card-5').toBeVisible();
    });

    await runTest('should display sort dropdown', async () => {
      await element('sort-dropdown').toBeVisible();
    });

    await runTest('should open sort options', async () => {
      await element('sort-dropdown').tap();
      await element('sort-options').toBeVisible();
      await element('sort-option-rating').toBeVisible();
      await element('sort-option-price-asc').toBeVisible();
      await element('sort-option-price-desc').toBeVisible();
      await element('sort-option-name').toBeVisible();
    });

    await runTest('should sort by price low to high', async () => {
      await element('sort-option-price-asc').tap();
      // Options should close
      const sortOptionsVisible = await element('sort-options').isVisible();
      if (sortOptionsVisible) {
        throw new Error('Sort options should be closed');
      }
    });

    await runTest('should add product to cart', async () => {
      await element('add-to-cart-1').tap();
      // Navigate to cart to verify
      await goCart();
      await element('cart-item-1').toBeVisible();
      await goProducts();
    });

    await runTest('should navigate to product detail', async () => {
      await element('product-card-2').tap();
      await waitForVisible('product-detail-screen');
      await element('product-title').toBeVisible();
    });
  } finally {
    teardown();
  }
}
