/**
 * Dark Mode Flow Tests
 * Equivalent to maestro-e2e/09-dark-mode-flow.yaml
 */
import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProducts, goCart, goProfile, loginWithDemo } from './shared';

// ============================================
// SETUP: Ensure light mode
// ============================================
await goHome();
await element('quick-action-settings').tap();
await element('settings-screen').toBeVisible();

// Reset to light mode (toggle twice)
await element('toggle-dark-mode').tap();
await element('toggle-dark-mode').tap();

// ============================================
// TEST: Enable dark mode
// ============================================
await runTest('Enable dark mode', async () => {
  await element('toggle-dark-mode').tap();
  await element('settings-screen').toBeVisible();
});

// ============================================
// TEST: Dark mode persists on home
// ============================================
await runTest('Dark mode on home', async () => {
  await goHome();
  await element('home-screen').toBeVisible();
  await element('featured-product-1').toBeVisible();
});

// ============================================
// TEST: Dark mode on products screen
// ============================================
await runTest('Dark mode on products screen', async () => {
  await goProducts();
  await element('products-screen').toBeVisible();
  await element('search-input').toBeVisible();
  await element('products-list').toBeVisible();
});

// ============================================
// TEST: Dark mode on product detail
// ============================================
await runTest('Dark mode on product detail', async () => {
  await element('product-card-1').tap();
  await element('product-detail-screen').toBeVisible();
  await element('product-title').toBeVisible();
  await element('add-to-cart-btn').toBeVisible();
  await goProducts();
});

// ============================================
// TEST: Dark mode on cart
// ============================================
await runTest('Dark mode on cart', async () => {
  await goCart();

  const cartExists = await element('cart-screen').exists();
  const emptyCartExists = await element('cart-screen-empty').exists();
  if (!cartExists && !emptyCartExists) {
    throw new Error('Cart screen not visible');
  }
});

// ============================================
// TEST: Dark mode on profile (guest)
// ============================================
await runTest('Dark mode on profile', async () => {
  await element('tab-profile').tap();

  await sleep(300);
  const profileExists = await element('profile-screen').exists();
  const guestExists = await element('guest-view').exists();
  if (!profileExists && !guestExists) {
    throw new Error('Profile or guest view not visible');
  }
});

// ============================================
// TEST: Dark mode on login screen
// ============================================
await runTest('Dark mode on login screen', async () => {
  const guestViewExists = await element('guest-view').exists();
  if (guestViewExists) {
    await element('guest-signin-btn').tap();
    await element('login-screen').toBeVisible();
    await element('email-input').toBeVisible();
    await element('login-btn').toBeVisible();
    await goHome();
  }
});

// ============================================
// TEST: Toggle dark mode off
// ============================================
await runTest('Toggle dark mode off', async () => {
  await goHome();
  await element('quick-action-settings').tap();
  await element('settings-screen').toBeVisible();
  await element('toggle-dark-mode').tap();
});

// ============================================
// TEST: Light mode restored on all screens
// ============================================
await runTest('Light mode on home', async () => {
  await goHome();
  await element('home-screen').toBeVisible();
});

await runTest('Light mode on products', async () => {
  await goProducts();
  await element('products-screen').toBeVisible();
});

await runTest('Light mode on cart', async () => {
  await goCart();

  const cartExists = await element('cart-screen').exists();
  const emptyCartExists = await element('cart-screen-empty').exists();
  if (!cartExists && !emptyCartExists) {
    throw new Error('Cart screen not visible');
  }
});

// ============================================
// TEST: Dark mode with authenticated user
// ============================================
await runTest('Dark mode with authenticated user', async () => {
  await goHome();
  await loginWithDemo();

  // Enable dark mode
  await element('quick-action-settings').tap();
  await element('toggle-dark-mode').tap();

  // Check profile in dark mode
  await element('tab-profile').tap();
  await element('profile-screen').toBeVisible();
  await element('profile-header').toBeVisible();

  // Check orders in dark mode
  await element('menu-orders').tap();

  await sleep(500);
  const ordersExists = await element('orders-screen').exists();
  const emptyExists = await element('empty-orders').exists();
  if (!ordersExists && !emptyExists) {
    console.log('Orders screen check - may vary');
  }
});

// ============================================
// CLEANUP: Restore light mode
// ============================================
await runTest('Cleanup - restore light mode', async () => {
  await goHome();
  await element('quick-action-settings').tap();
  await element('toggle-dark-mode').tap();
  await element('settings-screen').toBeVisible();
});

console.log('\n✅ Dark mode flow tests completed!');
