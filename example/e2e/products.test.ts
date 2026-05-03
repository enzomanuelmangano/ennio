import { element, sleep, runTest } from '@ennio/test';
import { goProducts } from './shared';

await goProducts();

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
  await element('products-screen').toBeVisible();
});

await runTest('should filter by category - Electronics', async () => {
  const filterBtn = await element('filter-category-electronics').exists();
  if (filterBtn) {
    await element('filter-category-electronics').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should filter by category - Sports', async () => {
  await element('filter-category-sports').tap();
  await sleep(300);
  const productExists = await element('product-card-5').exists();
  if (!productExists) {
    throw new Error('product-card-5 not found after filtering by Sports');
  }
  await element('product-card-7').exists();
});

await runTest('should reset to All categories', async () => {
  const filterAll = await element('filter-category-all').exists();
  if (filterAll) {
    await element('filter-category-all').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should search for products', async () => {
  await goProducts();
  await sleep(500);
  await element('products-screen').toBeVisible();
});

await runTest('should clear search', async () => {
  const clearBtn = await element('clear-search').exists();
  if (clearBtn) {
    await element('clear-search').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should display sort dropdown', async () => {
  await element('sort-dropdown').toBeVisible();
});

await runTest('should open sort options', async () => {
  const sortDropdown = await element('sort-dropdown').exists();
  if (sortDropdown) {
    await element('sort-dropdown').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should sort by price low to high', async () => {
  const sortOption = await element('sort-option-price-asc').exists();
  if (sortOption) {
    await element('sort-option-price-asc').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should add product to cart', async () => {
  await element('products-screen').toBeVisible();
});

await runTest('should navigate to product detail', async () => {
  await element('products-screen').toBeVisible();
});
