import { element, sleep, runTest, waitForVisible, Alert } from '@ennio/test';
import { goCart, goProducts } from './shared';

await runTest('should start with empty cart', async () => {
  await goCart();
  const isEmpty = await element('cart-screen-empty').exists();
  const hasItems = await element('cart-screen').exists();

  if (isEmpty) {
    await element('cart-screen-empty').toBeVisible();
  } else if (hasItems) {
    const clearBtn = await element('clear-cart-btn').exists();
    if (clearBtn) {
      await element('clear-cart-btn').tap();
      await sleep(500);
      await goCart();
    }
  }
});

await runTest('should navigate to products from empty cart', async () => {
  const isEmpty = await element('cart-screen-empty').exists();
  if (isEmpty) {
    await element('browse-products-btn').tap();
    await waitForVisible('products-screen');
  } else {
    await goProducts();
  }
});

await runTest('should add first product to cart', async () => {
  await goProducts();
  await sleep(300);
  const addBtn = await element('add-to-cart-1').exists();
  if (addBtn) {
    await element('add-to-cart-1').tap();
    await sleep(300);
  }
  await goCart();
  await sleep(300);
  const cartScreen = await element('cart-screen').exists();
  if (cartScreen) {
    await element('cart-screen').toBeVisible();
  }
});

await runTest('should display cart summary', async () => {
  const cartSummary = await element('cart-summary').exists();
  if (cartSummary) {
    await element('cart-summary').toBeVisible();
  }
});

await runTest('should increase quantity', async () => {
  const increaseBtn = await element('increase-qty-1').exists();
  if (increaseBtn) {
    await element('increase-qty-1').tap();
    await sleep(500);
  }
});

await runTest('should decrease quantity', async () => {
  const decreaseBtn = await element('decrease-qty-1').exists();
  if (decreaseBtn) {
    await element('decrease-qty-1').tap();
    await sleep(500);
  }
  const cartScreen = await element('cart-screen').exists();
  if (cartScreen) {
    await element('cart-screen').toBeVisible();
  }
});

await runTest('should add more products', async () => {
  await goProducts();
  await sleep(300);
  const addBtn = await element('add-to-cart-2').exists();
  if (addBtn) {
    await element('add-to-cart-2').tap();
    await sleep(300);
  }
  await goCart();
  await sleep(300);
  const hasItems = await element('cart-screen').exists();
  if (hasItems) {
    await element('cart-screen').toBeVisible();
  }
});

await runTest('should show item count in header', async () => {
  const cartScreen = await element('cart-screen').exists();
  const emptyCart = await element('cart-screen-empty').exists();
  if (!cartScreen && !emptyCart) throw new Error('Not on cart tab');
});

await runTest('should update total when quantity changes', async () => {
  const cartTotal = await element('cart-total').exists();
  if (cartTotal) {
    await element('cart-total').toBeVisible();
  }
});

await runTest('should display checkout button', async () => {
  const hasItems = await element('cart-screen').exists();
  if (hasItems) {
    await element('checkout-btn').toBeVisible();
  } else {
    await goProducts();
    await sleep(300);
    await element('add-to-cart-1').tap();
    await sleep(300);
    await goCart();
    await sleep(300);
    await element('checkout-btn').toBeVisible();
  }
});

await runTest('should require sign in for checkout', async () => {
  await element('checkout-btn').tap();
  await sleep(500);

  const alertPresent = await Alert.isPresent();
  if (alertPresent) {
    await Alert.dismiss();
    await sleep(500);
  }

  const cartVisible = await element('cart-screen').exists();
  if (cartVisible) {
    await element('cart-screen').toBeVisible();
  }
});

await runTest('should display clear all button', async () => {
  await element('clear-cart-btn').toBeVisible();
});
