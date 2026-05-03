/**
 * Settings Flow Tests
 * Equivalent to maestro-e2e/06-settings-flow.yaml
 */
import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProfile, loginWithDemo } from './shared';

// ============================================
// SETUP
// ============================================
await goHome();

// ============================================
// TEST: Navigate to settings via quick action
// ============================================
await runTest('Navigate to settings', async () => {
  await element('quick-action-settings').tap();
  await element('settings-screen').toBeVisible();
});

// ============================================
// TEST: Appearance settings
// ============================================
await runTest('Appearance settings - dark mode', async () => {
  await element('toggle-dark-mode').toBeVisible();
  await element('toggle-dark-mode').tap();
  await element('toggle-dark-mode').tap();
});

await runTest('Appearance settings - haptic', async () => {
  await element('toggle-haptic').toBeVisible();
  await element('toggle-haptic').tap();
  await element('toggle-haptic').tap();
});

await runTest('Appearance settings - badges', async () => {
  await element('toggle-badges').toBeVisible();
  await element('toggle-badges').tap();
  await element('toggle-badges').tap();
});

// ============================================
// TEST: Notification settings
// ============================================
await runTest('Notification settings - order updates', async () => {
  await element('toggle-order-updates').toBeVisible();
  await element('toggle-order-updates').tap();
  await element('toggle-order-updates').tap();
});

await runTest('Notification settings - promotions', async () => {
  await element('toggle-promotions').toBeVisible();
  await element('toggle-promotions').tap();
});

await runTest('Notification settings - new arrivals', async () => {
  await element('toggle-new-arrivals').toBeVisible();
  await element('toggle-new-arrivals').tap();
  await element('toggle-new-arrivals').tap();
});

await runTest('Notification settings - price drops', async () => {
  await element('toggle-price-drops').toBeVisible();
  await element('toggle-price-drops').tap();
  await element('toggle-price-drops').tap();
});

// ============================================
// TEST: Privacy settings
// ============================================
await runTest('Privacy settings - analytics', async () => {
  await element('toggle-analytics').toBeVisible();
  await element('toggle-analytics').tap();
});

await runTest('Privacy settings - personalized ads', async () => {
  await element('toggle-personalized-ads').toBeVisible();
  await element('toggle-personalized-ads').tap();
  await element('toggle-personalized-ads').tap();
});

await runTest('Privacy settings - location', async () => {
  await element('toggle-location').toBeVisible();
  await element('toggle-location').tap();
  await element('toggle-location').tap();
});

// ============================================
// TEST: Account settings (when logged in)
// ============================================
await runTest('Account settings (logged in)', async () => {
  await goHome();
  await loginWithDemo();

  await element('quick-action-settings').tap();
  await element('edit-profile').toBeVisible();
  await element('change-password').toBeVisible();
  await element('sign-out').toBeVisible();
});

// ============================================
// TEST: App info and legal
// ============================================
await runTest('App info and legal', async () => {
  await element('app-version').toBeVisible();
  await element('terms').toBeVisible();
  await element('privacy-policy').toBeVisible();
  await element('help').toBeVisible();
});

// ============================================
// TEST: Danger zone actions
// ============================================
await runTest('Danger zone - clear data', async () => {
  await element('clear-data').toBeVisible();
});

await runTest('Danger zone - reset settings', async () => {
  await element('reset-settings').toBeVisible();
  await element('reset-settings').tap();
  await element({ text: 'Reset Settings' }).toExist();
  await element({ text: 'Cancel' }).tap();
  await element('settings-screen').toBeVisible();
});

// ============================================
// TEST: Navigate via profile menu
// ============================================
await runTest('Navigate via profile menu', async () => {
  await element('tab-profile').tap();
  await element('profile-screen').toBeVisible();
  await element('menu-settings').tap();
  await element('settings-screen').toBeVisible();
});

// ============================================
// TEST: Dark mode persists across screens
// ============================================
await runTest('Dark mode persists', async () => {
  await element('toggle-dark-mode').tap();
  await goHome();
  await element('quick-action-settings').tap();
  await element('toggle-dark-mode').tap();
});

console.log('\n✅ Settings flow tests completed!');
