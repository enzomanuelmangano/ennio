/**
 * Shared helpers for Maestro-equivalent Ennio tests
 */
import { element, sleep, waitForVisible } from '@ennio/test';

// Navigation helpers
export async function goHome() {
  await element('tab-home').tap();
  await element('home-screen').toBeVisible();
}

export async function goProducts() {
  await element('tab-products').tap();
  await element('products-screen').toBeVisible();
}

export async function goCart() {
  await element('tab-cart').tap();
  // Cart can be empty or populated
  const cartExists = await element('cart-screen').exists();
  const emptyCartExists = await element('cart-screen-empty').exists();
  if (!cartExists && !emptyCartExists) {
    throw new Error('Cart screen not visible');
  }
}

export async function goProfile() {
  await element('tab-profile').tap();
  await sleep(300);
}

// Auth helpers
export async function ensureLoggedOut() {
  await goProfile();
  const logoutBtn = await element('menu-logout').exists();
  if (logoutBtn) {
    await element('menu-logout').tap();
    await element({ text: 'Sign Out' }).tap();
    await element('guest-view').toBeVisible();
  }
}

export async function loginWithDemo() {
  await goHome();
  const signinBtn = await element('home-signin-btn').exists();
  if (signinBtn) {
    await element('home-signin-btn').tap();
    await element('login-screen').toBeVisible();
    await element('demo-login-btn').tap();
    await element('home-screen').toBeVisible();
  }
}

// Cart helpers
export async function clearCart() {
  await goCart();
  const clearBtn = await element('clear-cart-btn').exists();
  if (clearBtn) {
    await element('clear-cart-btn').tap();
    await element({ text: 'Clear' }).tap();
    await element('cart-screen-empty').toBeVisible();
  }
}

export async function addProductToCartFromProducts(productId = '1') {
  await goProducts();
  await element(`add-to-cart-${productId}`).tap();
}

export async function addProductToCartFromDetail(productId = '1') {
  await goProducts();
  await element(`product-card-${productId}`).tap();
  await element('product-detail-screen').toBeVisible();
  await element('add-to-cart-btn').tap();
  await element({ text: 'Added to Cart' }).toBeVisible();
  await element({ text: 'Continue Shopping' }).tap();
}
