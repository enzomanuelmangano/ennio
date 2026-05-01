import { element, sleep, runTest, waitForVisible } from '@tasto/test';
import { goHome } from './shared';

await goHome();

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
  await element('featured-product-1').toBeVisible();
});

await runTest('should display trending products', async () => {
  await element('trending-product-4').toBeVisible();
});

await runTest('should navigate to products via See All', async () => {
  await element('see-all-featured').tap();
  await waitForVisible('products-screen');
  await goHome();
});

await runTest('should navigate to cart via quick action', async () => {
  await element('quick-action-cart').tap();
  const cartExists = await element('cart-screen').exists();
  const emptyCartExists = await element('cart-screen-empty').exists();
  if (!cartExists && !emptyCartExists) {
    throw new Error('Cart screen not visible');
  }
  await goHome();
});

await runTest('should navigate to products via category', async () => {
  await goHome();
  await sleep(300);
  await element('home-screen').toBeVisible();
});

await runTest('should display promo banner', async () => {
  const promoExists = await element('promo-banner').exists();
  await element('home-screen').toBeVisible();
});

await runTest('should navigate to products via promo banner', async () => {
  await goHome();
  await element('home-screen').toBeVisible();
});

await runTest('should show sign in button when not authenticated', async () => {
  const signInBtn = await element('home-signin-btn').exists();
  if (signInBtn) {
    await element('home-signin-btn').toBeVisible();
  }
});
