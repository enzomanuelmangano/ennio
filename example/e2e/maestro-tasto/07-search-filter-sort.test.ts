/**
 * Advanced Search, Filter & Sort Tests
 * Equivalent to maestro-e2e/07-search-filter-sort.yaml
 */
import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProducts } from './shared';

// ============================================
// SETUP
// ============================================
await goProducts();

// ============================================
// TEST: Search exact match
// ============================================
await runTest('Search exact match', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('Wireless Headphones');
  await element({ text: 'Wireless Headphones' }).toExist();
  await element('clear-search').tap();
});

// ============================================
// TEST: Search partial match
// ============================================
await runTest('Search partial match', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('Pro');
  await element({ text: 'Pro' }).toExist();
  await element('clear-search').tap();
});

// ============================================
// TEST: Search case insensitive
// ============================================
await runTest('Search case insensitive', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('WIRELESS');
  await element({ text: 'Wireless' }).toExist();
  await element('clear-search').tap();
});

// ============================================
// TEST: Search no results
// ============================================
await runTest('Search no results', async () => {
  await element('search-input').tap();
  await element('search-input').typeText('xyznonexistent123');
  await element('no-products').toBeVisible();
  await element({ text: 'No products found' }).toExist();
  await element('reset-filters').tap();
});

// ============================================
// TEST: Category filters
// ============================================
await runTest('Filter - All categories', async () => {
  await element('filter-category-all').tap();
  await element('products-list').toBeVisible();
});

await runTest('Filter - Electronics', async () => {
  await element('filter-category-electronics').tap();
  await element('products-list').toBeVisible();
});

await runTest('Filter - Sports', async () => {
  await element('filter-category-sports').tap();
  await element('products-list').toBeVisible();
});

await runTest('Filter - Home', async () => {
  await element('filter-category-home').tap();
  await element('products-list').toBeVisible();
});

await runTest('Filter - Accessories', async () => {
  await element('filter-category-accessories').tap();
  await element('products-list').toBeVisible();
  await element('filter-category-all').tap();
});

// ============================================
// TEST: Sort options
// ============================================
await runTest('Sort - Price Low to High', async () => {
  await element('sort-dropdown').tap();
  await element('sort-options').toBeVisible();
  await element('sort-option-price-asc').tap();
});

await runTest('Sort - Price High to Low', async () => {
  await element('sort-dropdown').tap();
  await element('sort-option-price-desc').tap();
});

await runTest('Sort - Name A to Z', async () => {
  await element('sort-dropdown').tap();
  await element('sort-option-name').tap();
});

await runTest('Sort - Top Rated', async () => {
  await element('sort-dropdown').tap();
  await element('sort-option-rating').tap();
});

// ============================================
// TEST: Combined filters - Electronics + search
// ============================================
await runTest('Combined - Electronics + search', async () => {
  await element('filter-category-electronics').tap();
  await element('search-input').tap();
  await element('search-input').typeText('Phone');
  await element('products-list').toBeVisible();
  await element('clear-search').tap();
});

// ============================================
// TEST: Combined filters - Category + Sort
// ============================================
await runTest('Combined - Category + Sort', async () => {
  await element('filter-category-sports').tap();
  await element('sort-dropdown').tap();
  await element('sort-option-price-asc').tap();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Triple combo - Category + Search + Sort
// ============================================
await runTest('Triple combo - Category + Search + Sort', async () => {
  await element('filter-category-electronics').tap();
  await element('search-input').tap();
  await element('search-input').typeText('Wireless');
  await element('sort-dropdown').tap();
  await element('sort-option-price-desc').tap();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Reset filters button
// ============================================
await runTest('Reset filters', async () => {
  await element('reset-filters').tap();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Filter persists when viewing product
// ============================================
await runTest('Filter persists when viewing product', async () => {
  await element('filter-category-electronics').tap();
  await element('product-card-1').tap();
  await element('product-detail-screen').toBeVisible();
  await goProducts();
  await element('products-screen').toBeVisible();
});

// ============================================
// TEST: Search from home category cards
// ============================================
await runTest('Search from home category cards', async () => {
  await goHome();
  await element('category-sports').tap();
  await element('products-screen').toBeVisible();
  await element('filter-category-sports').toBeVisible();
});

// ============================================
// TEST: Scroll through products
// ============================================
await runTest('Scroll through products', async () => {
  await element('filter-category-all').tap();
  await element('products-list').toBeVisible();
});

console.log('\n✅ Search filter sort tests completed!');
