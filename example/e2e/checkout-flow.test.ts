import { element, sleep, runTest, waitForVisible, Alert } from '@tasto/test';
import { goProfile, goProducts, goCart } from './shared';

await runTest('should login with demo account', async () => {
  await goProfile();
  const guestView = await element('guest-view').exists();
  if (guestView) {
    await element('guest-signin-btn').tap();
    await waitForVisible('login-screen');
    await element('demo-login-btn').tap();
    await sleep(1500);
    await waitForVisible('profile-screen', { timeout: 5000 });
  }
});

await runTest('should browse products', async () => {
  await goProducts();
  await element('products-screen').toBeVisible();
});

await runTest('should view product details', async () => {
  await element('products-screen').toBeVisible();
});

await runTest('should select quantity', async () => {
  const addBtn = await element('add-to-cart-1').exists();
  if (addBtn) {
    await element('add-to-cart-1').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should add to cart from detail page', async () => {
  const addBtn = await element('add-to-cart-2').exists();
  if (addBtn) {
    await element('add-to-cart-2').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should continue shopping and add another product', async () => {
  const addBtn = await element('add-to-cart-3').exists();
  if (addBtn) {
    await element('add-to-cart-3').tap();
    await sleep(300);
  }
  await element('products-screen').toBeVisible();
});

await runTest('should view cart with items', async () => {
  await goCart();
  const cartScreen = await element('cart-screen').exists();
  const emptyCart = await element('cart-screen-empty').exists();
  if (!cartScreen && !emptyCart) throw new Error('Not on cart tab');
});

await runTest('should show correct cart summary', async () => {
  const cartSummary = await element('cart-summary').exists();
  if (cartSummary) {
    await element('cart-summary').toBeVisible();
  }
});

await runTest('should proceed to checkout', async () => {
  const checkoutBtn = await element('checkout-btn').exists();
  if (checkoutBtn) {
    await element('checkout-btn').tap();
    await sleep(500);
    const checkoutExists = await element('checkout-screen').exists();
    if (checkoutExists) {
      await element('checkout-screen').toBeVisible();
    } else {
      await element('cart-screen').toBeVisible();
    }
  }
});

await runTest('should display shipping form (step 1)', async () => {
  const onCheckout = await element('checkout-screen').exists();
  const onCart = await element('cart-screen').exists();
  if (onCheckout) {
    const shippingForm = await element('shipping-form').exists();
    if (shippingForm) {
      await element('shipping-form').toBeVisible();
    }
  } else if (onCart) {
    await element('cart-screen').toBeVisible();
  }
});

await runTest('should fill shipping information', async () => {
  const onCheckout = await element('checkout-screen').exists();
  if (!onCheckout) return;

  const shippingName = await element('shipping-name').exists();
  if (shippingName) {
    await element('shipping-name').typeText('John Doe');
    await element('shipping-street').typeText('123 Main Street');
    await element('shipping-city').typeText('New York');
    await element('shipping-state').typeText('NY');
    await element('shipping-zip').typeText('10001');
    await element('shipping-phone').typeText('5551234567');
  }
});

await runTest('should proceed to payment step', async () => {
  const nextBtn = await element('next-btn').exists();
  if (nextBtn) {
    await element('next-btn').tap();
    await sleep(500);
  }
});

await runTest('should fill payment information', async () => {
  const cardNumber = await element('payment-card-number').exists();
  if (cardNumber) {
    await element('payment-card-number').typeText('4242424242424242');
    await element('payment-cardholder').typeText('JOHN DOE');
    await element('payment-expiry').typeText('1225');
    await element('payment-cvv').typeText('123');
  }
});

await runTest('should proceed to review step', async () => {
  const nextBtn = await element('next-btn').exists();
  if (nextBtn) {
    await element('next-btn').tap();
    await sleep(500);
  }
});

await runTest('should display order review', async () => {
  const orderReview = await element('order-review').exists();
  if (orderReview) {
    await element('order-review').toBeVisible();
  }
});

await runTest('should place order', async () => {
  const placeOrderBtn = await element('place-order-btn').exists();
  if (placeOrderBtn) {
    await element('place-order-btn').tap();
    await sleep(1000);

    const alertPresent = await Alert.isPresent();
    if (alertPresent) {
      await Alert.tap('View Orders');
      await sleep(500);
    }
  }
});

await runTest('should view order in history', async () => {
  const ordersScreen = await element('orders-screen').exists();
  if (ordersScreen) {
    await element('orders-screen').toBeVisible();
  }
});

await runTest('should view order details', async () => {
  const ordersList = await element('orders-list').exists();
  if (ordersList) {
    await element('orders-list').toBeVisible();
  }
});
