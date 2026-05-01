/**
 * Selector Validation Tests
 *
 * Tests for the new Maestro-compatible selector syntax.
 * Validates: text, spatial, state, hierarchical, and dimension selectors.
 *
 * Uses built-in flakiness handling - no manual retries needed.
 */
import { element, elements, sleep, runTest } from '@tasto/test';
import { goHome, goProducts } from './shared';

await goHome();

// ============================================
// PRIMARY SELECTORS
// ============================================

await runTest('[selector] find by id (legacy testID)', async () => {
  await element('home-screen').toBeVisible();
});

await runTest('[selector] find by id (object syntax)', async () => {
  await element({ id: 'home-screen' }).toBeVisible();
});

await runTest('[selector] find by exact text', async () => {
  // "See All" link on home screen - uses built-in wait
  await element({ text: 'See All' }).toExist();
});

await runTest('[selector] find by text contains', async () => {
  // "Summer Sale!" contains "Summer"
  await element({
    text: { pattern: 'Summer', mode: 'contains' },
  }).toExist();
});

await runTest('[selector] find by text startsWith', async () => {
  // "Featured Products" starts with "Featured"
  await element({
    text: { pattern: 'Featured', mode: 'startsWith' },
  }).toExist();
});

await runTest('[selector] find by text regex', async () => {
  // Match any price like "$12.99"
  await element({
    text: { pattern: '\\$\\d+\\.\\d{2}', mode: 'regex' },
  }).toExist();
});

// ============================================
// STATE SELECTORS
// ============================================

await runTest('[selector] find enabled element', async () => {
  // Quick action buttons should be enabled
  await element({
    id: 'quick-action-search',
    enabled: true,
  }).toExist();
});

// ============================================
// COMBINED SELECTORS
// ============================================

await runTest('[selector] combine id + enabled', async () => {
  await element({
    id: 'quick-action-cart',
    enabled: true,
  }).toExist();
});

await runTest('[selector] combine text + enabled', async () => {
  // "See All" should be enabled
  await element({
    text: 'See All',
    enabled: true,
  }).toExist();
});

// ============================================
// INDEX SELECTOR
// ============================================

await runTest('[selector] index selector (nth match)', async () => {
  // There are multiple "Add to Cart" buttons - get the first one
  await element({
    text: 'Add to Cart',
    index: 0,
  }).toExist();
});

// ============================================
// SPATIAL SELECTORS
// ============================================

await runTest('[selector] below - find element below another', async () => {
  // Find "Featured Products" title
  await element({
    text: { pattern: 'Featured', mode: 'startsWith' },
  }).toExist();

  // Find element below it
  const belowExists = await element({
    text: 'Add to Cart',
    below: { text: { pattern: 'Featured', mode: 'startsWith' } },
  }).exists();
  console.log('Below selector result:', belowExists);
});

// ============================================
// ELEMENTS (FIND ALL)
// ============================================

await runTest('[selector] elements() finds multiple matches', async () => {
  const addToCartButtons = await elements({ text: 'Add to Cart' });
  console.log(`Found ${addToCartButtons.length} "Add to Cart" buttons`);
  if (addToCartButtons.length === 0) {
    throw new Error('No "Add to Cart" buttons found');
  }
});

// ============================================
// PRODUCTS SCREEN TESTS
// ============================================

await runTest('[selector] products screen - text selectors', async () => {
  await goProducts();
  await element('products-screen').toBeVisible();

  const searchExists = await element({
    text: { pattern: 'products', mode: 'contains' },
  }).exists();
  console.log('Products count text found:', searchExists);
});

await runTest('[selector] products screen - sort dropdown', async () => {
  // Sort dropdown should be visible and enabled - uses auto-wait
  await element({
    id: 'sort-dropdown',
    enabled: true,
  }).toExist();
});

await runTest('[selector] products screen - category filter', async () => {
  await element({
    id: 'filter-category-all',
  }).toExist();
});

// ============================================
// TRAIT SELECTORS
// ============================================

await runTest('[selector] trait: text - find elements with text', async () => {
  const elementsWithText = await elements({
    traits: ['text'],
  });
  console.log(`Found ${elementsWithText.length} elements with text trait`);
  if (elementsWithText.length === 0) {
    throw new Error('No elements with text trait found');
  }
});

// ============================================
// INTERACTION TESTS
// ============================================

await runTest('[selector] tap by text selector', async () => {
  await goHome();

  // Tap "See All" using text selector - auto-waits before tap
  await element({ text: 'See All' }).tap();

  // Should navigate to products - auto-waits
  await element('products-screen').toBeVisible();

  await goHome();
});

await runTest('[selector] tap by combined selector', async () => {
  await goHome();

  // Tap with combined selector (id + enabled) - auto-waits
  await element({
    id: 'quick-action-cart',
    enabled: true,
  }).tap();

  // Navigation happens - test passes if tap worked
  await sleep(300);
  await goHome();
});

// ============================================
// BACKWARD COMPATIBILITY
// ============================================

await runTest('[selector] backward compat - string selector still works', async () => {
  await element('home-screen').toBeVisible();
  await element('quick-action-search').tap();
  await element('products-screen').toBeVisible();
  await goHome();
});

console.log('\n✅ All selector tests completed!');
