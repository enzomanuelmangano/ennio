/**
 * Orders Management Tests
 * Equivalent to maestro-e2e/05-orders-management.yaml
 */
import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProfile, loginWithDemo, ensureLoggedOut } from './shared';

// ============================================
// SETUP: Login with demo account
// ============================================
await goHome();
await loginWithDemo();

// ============================================
// TEST: Navigate to orders via quick action
// ============================================
await runTest('Navigate to orders via quick action', async () => {
  await goHome();
  await element('quick-action-orders').tap();
  await sleep(500);

  const ordersExists = await element('orders-screen').exists();
  const emptyExists = await element('empty-orders').exists();
  if (!ordersExists && !emptyExists) {
    throw new Error('Orders or empty orders screen not visible');
  }
});

// ============================================
// TEST: Orders list or empty state
// ============================================
await runTest('Orders list or empty state', async () => {
  const emptyExists = await element('empty-orders').exists();
  if (emptyExists) {
    await element({ text: 'No orders yet' }).toExist();
    await element('browse-products').toBeVisible();
  } else {
    await element('orders-screen').toBeVisible();
  }
});

// ============================================
// TEST: Navigate to orders via profile menu
// ============================================
await runTest('Navigate to orders via profile', async () => {
  await element('tab-profile').tap();
  await element('profile-screen').toBeVisible();
  await element('menu-orders').tap();

  await sleep(500);
  const ordersExists = await element('orders-screen').exists();
  const emptyExists = await element('empty-orders').exists();
  if (!ordersExists && !emptyExists) {
    throw new Error('Orders or empty orders screen not visible');
  }
});

// ============================================
// TEST: Order card displays correctly
// ============================================
await runTest('Order card displays correctly', async () => {
  const ordersListExists = await element('orders-list').exists();
  if (ordersListExists) {
    // Check order status visible
    const processingExists = await element({ text: 'Processing' }).exists();
    const shippedExists = await element({ text: 'Shipped' }).exists();
    const deliveredExists = await element({ text: 'Delivered' }).exists();

    if (!processingExists && !shippedExists && !deliveredExists) {
      console.log('No order status found - may be empty');
    }
  }
});

// ============================================
// TEST: View order details
// ============================================
await runTest('View order details', async () => {
  const ordersListExists = await element('orders-list').exists();
  if (ordersListExists) {
    // Tap first order
    await element({
      below: { text: 'Order' },
      index: 0,
    }).tap();

    await element('order-details').toBeVisible();
    await element({ text: 'Shipping' }).toExist();
    await element('close-details').tap();
    await element('orders-screen').toBeVisible();
  }
});

// ============================================
// TEST: Guest user orders view
// ============================================
await runTest('Guest user orders view', async () => {
  // Logout
  await goProfile();
  await element('menu-logout').tap();
  await element({ text: 'Sign Out' }).tap();
  await element('guest-view').toBeVisible();

  // Try to access orders
  await goHome();
  await element('quick-action-orders').tap();

  await element('orders-guest').toBeVisible();
  await element({ text: 'Sign in to view orders' }).toExist();
  await element('sign-in-btn').toBeVisible();
});

// ============================================
// TEST: Sign in from orders guest view
// ============================================
await runTest('Sign in from orders guest view', async () => {
  await element('sign-in-btn').tap();
  await element('login-screen').toBeVisible();
  await element('demo-login-btn').tap();

  await sleep(500);
  const ordersExists = await element('orders-screen').exists();
  const emptyExists = await element('empty-orders').exists();
  if (!ordersExists && !emptyExists) {
    throw new Error('Orders or empty orders screen not visible after login');
  }
});

console.log('\n✅ Orders management tests completed!');
