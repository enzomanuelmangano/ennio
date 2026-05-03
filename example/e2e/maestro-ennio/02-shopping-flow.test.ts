/**
 * Shopping Flow Tests
 * Equivalent to maestro-e2e/02-shopping-flow.yaml
 */
import { element, elements, sleep, runTest } from '@ennio/test';
import { goHome, goProducts } from './shared';

// ============================================
// SETUP
// ============================================
await goHome();

// ============================================
// TEST: Home screen featured products
// ============================================
await runTest('Home screen featured products', async () => {
  await element('featured-product-1').toBeVisible();
  await element('featured-product-2').toBeVisible();
  await element({ text: 'Featured Products' }).toExist();
});

// ============================================
// TEST: Quick actions on home
// ============================================
await runTest('Quick actions visible', async () => {
  await element('quick-action-search').toBeVisible();
  await element('quick-action-cart').toBeVisible();
  await element('quick-action-orders').toBeVisible();
  await element('quick-action-settings').toBeVisible();
});

// ============================================
// TEST: Navigate to products via "See All"
// ============================================
await runTest('Navigate to products via See All', async () => {
  await element('see-all-featured').tap();
  await element('products-screen').toBeVisible();
});

// ============================================
// TEST: Products screen displays correctly
// ============================================
await runTest('Products screen displays correctly', async () => {
  await element('search-input').toBeVisible();
  await element('sort-dropdown').toBeVisible();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Search functionality
// ============================================
await runTest('Search functionality', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('Wireless');
  await element({ text: 'Wireless' }).toExist();
  await element('clear-search').tap();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Category filtering
// ============================================
await runTest('Category filtering', async () => {
  // Electronics
  await element('filter-category-electronics').tap();
  await element({ text: 'Electronics' }).toExist();

  // Sports
  await element('filter-category-sports').tap();
  await element({ text: 'Sports' }).toExist();

  // Reset
  await element('filter-category-all').tap();
});

// ============================================
// TEST: Sort functionality
// ============================================
await runTest('Sort functionality', async () => {
  await element('sort-dropdown').tap();
  await element('sort-options').toBeVisible();
  await element('sort-option-price-asc').tap();

  await element('sort-dropdown').tap();
  await element('sort-option-price-desc').tap();

  await element('sort-dropdown').tap();
  await element('sort-option-name').tap();

  await element('sort-dropdown').tap();
  await element('sort-option-rating').tap();
});

// ============================================
// TEST: Combined search + filter + sort
// ============================================
await runTest('Combined search + filter + sort', async () => {
  await element('filter-category-electronics').tap();
  await element('search-input').tap();
  await element('search-input').typeText('Pro');
  await element('sort-dropdown').tap();
  await element('sort-option-price-desc').tap();
  await element('products-list').toBeVisible();

  // Reset
  const resetExists = await element('reset-filters').exists();
  if (resetExists) {
    await element('reset-filters').tap();
  }
});

// ============================================
// TEST: Product detail navigation
// ============================================
await runTest('Product detail navigation', async () => {
  await element('filter-category-all').tap();
  await element('clear-search').tap();
  await element('product-card-1').tap();
  await element('product-detail-screen').toBeVisible();
});

// ============================================
// TEST: Product detail content
// ============================================
await runTest('Product detail content', async () => {
  await element('product-title').toBeVisible();
  await element('product-price').toBeVisible();
  await element('add-to-cart-btn').toBeVisible();
});

// ============================================
// TEST: Product tabs
// ============================================
await runTest('Product tabs', async () => {
  await element('tab-description').tap();
  await element('product-description').toBeVisible();

  await element('tab-specs').tap();
  await element('product-specs').toBeVisible();

  await element('tab-reviews').tap();
  await element('product-reviews').toBeVisible();
});

// ============================================
// TEST: Quantity adjustment
// ============================================
await runTest('Quantity adjustment', async () => {
  await element('quantity-value').toBeVisible();
  await element('increase-quantity').tap();
  await element('increase-quantity').tap();
  await element('decrease-quantity').tap();
});

// ============================================
// TEST: Navigate back
// ============================================
await runTest('Navigate back to products', async () => {
  await goProducts();
  await element('products-screen').toBeVisible();
});

// ============================================
// TEST: Category navigation from home
// ============================================
await runTest('Category navigation from home', async () => {
  await goHome();
  await element('category-electronics').tap();
  await element('products-screen').toBeVisible();
  await element('filter-category-electronics').toBeVisible();
});

console.log('\n✅ Shopping flow tests completed!');
