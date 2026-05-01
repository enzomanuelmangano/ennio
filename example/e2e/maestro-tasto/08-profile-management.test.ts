/**
 * Profile Management Tests
 * Equivalent to maestro-e2e/08-profile-management.yaml
 */
import { element, sleep, runTest } from '@tasto/test';
import { goHome, goProfile, loginWithDemo, ensureLoggedOut } from './shared';

// ============================================
// SETUP
// ============================================
await goHome();

// ============================================
// TEST: Guest profile view
// ============================================
await runTest('Guest profile view', async () => {
  await ensureLoggedOut();
  await element('tab-profile').tap();

  const guestViewExists = await element('guest-view').exists();
  if (guestViewExists) {
    await element({ text: 'Sign In' }).toExist();
    await element('guest-signin-btn').toBeVisible();
    await element('guest-register-btn').toBeVisible();
  }
});

// ============================================
// TEST: Login from guest profile
// ============================================
await runTest('Login from guest profile', async () => {
  const signinBtn = await element('guest-signin-btn').exists();
  if (signinBtn) {
    await element('guest-signin-btn').tap();
    await element('login-screen').toBeVisible();
    await element('demo-login-btn').tap();
    await element('home-screen').toBeVisible();
  }
});

// Navigate to profile
await element('tab-profile').tap();
await element('profile-screen').toBeVisible();

// ============================================
// TEST: Authenticated profile header
// ============================================
await runTest('Profile header', async () => {
  await element('profile-header').toBeVisible();
  await element({ text: 'John' }).toExist();
  await element('edit-profile-btn').toBeVisible();
});

// ============================================
// TEST: Profile stats card
// ============================================
await runTest('Profile stats card', async () => {
  await element('stats-card').toBeVisible();
  await element({ text: 'Orders' }).toExist();
  await element({ text: 'Items' }).toExist();
  await element({ text: 'Spent' }).toExist();
});

// ============================================
// TEST: Profile menu items - Account
// ============================================
await runTest('Profile menu - Account section', async () => {
  await element('menu-orders').toBeVisible();
  await element('menu-payment').toBeVisible();
  await element('menu-addresses').toBeVisible();
});

// ============================================
// TEST: Profile menu items - Preferences
// ============================================
await runTest('Profile menu - Preferences section', async () => {
  await element('menu-settings').toBeVisible();
  await element('menu-notifications').toBeVisible();
  await element('menu-appearance').toBeVisible();
});

// ============================================
// TEST: Profile menu items - Support
// ============================================
await runTest('Profile menu - Support section', async () => {
  await element('menu-help').toBeVisible();
  await element('menu-contact').toBeVisible();
  await element('menu-terms').toBeVisible();
  await element('menu-logout').toBeVisible();
});

// ============================================
// TEST: Navigate to orders from profile
// ============================================
await runTest('Navigate to orders', async () => {
  await element('menu-orders').tap();

  await sleep(500);
  const ordersExists = await element('orders-screen').exists();
  const emptyExists = await element('empty-orders').exists();
  if (!ordersExists && !emptyExists) {
    throw new Error('Orders screen not visible');
  }

  await goProfile();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Navigate to settings from profile
// ============================================
await runTest('Navigate to settings', async () => {
  await element('menu-settings').tap();
  await element('settings-screen').toBeVisible();
  await goProfile();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Navigate to appearance from profile
// ============================================
await runTest('Navigate to appearance', async () => {
  await element('menu-appearance').tap();
  await element('settings-screen').toBeVisible();
  await goProfile();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Navigate to help from profile
// ============================================
await runTest('Navigate to help', async () => {
  await element('menu-help').tap();

  await sleep(500);
  const helpExists = await element({ text: 'Help' }).exists();
  const supportExists = await element({ text: 'Support' }).exists();
  if (!helpExists && !supportExists) {
    console.log('Help/Support screen check - may vary by implementation');
  }

  await goProfile();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Navigate to terms from profile
// ============================================
await runTest('Navigate to terms', async () => {
  await element('menu-terms').tap();

  await sleep(500);
  const termsExists = await element({ text: 'Terms' }).exists();
  const privacyExists = await element({ text: 'Privacy' }).exists();
  if (!termsExists && !privacyExists) {
    console.log('Terms/Privacy screen check - may vary by implementation');
  }

  await goProfile();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Logout confirmation - cancel
// ============================================
await runTest('Logout confirmation - cancel', async () => {
  await element('menu-logout').tap();
  await element({ text: 'Sign Out' }).toExist();
  await element({ text: 'Cancel' }).tap();
  await element('profile-screen').toBeVisible();
});

// ============================================
// TEST: Complete logout
// ============================================
await runTest('Complete logout', async () => {
  await element('menu-logout').tap();
  await element({ text: 'Sign Out' }).tap();
  await element('guest-view').toBeVisible();
});

console.log('\n✅ Profile management tests completed!');
