/**
 * Authentication Flow Tests
 * Equivalent to maestro-e2e/01-auth-flow.yaml
 */
import { element, runTest } from '@tasto/test';
import { goHome, goProfile, ensureLoggedOut } from './shared';

// ============================================
// SETUP: Ensure logged out state
// ============================================
await ensureLoggedOut();
await goHome();

// ============================================
// TEST: Navigate to login screen
// ============================================
await runTest('Navigate to login screen', async () => {
  await element('home-signin-btn').toBeVisible();
  await element('home-signin-btn').tap();
  await element('login-screen').toBeVisible();
});

// ============================================
// TEST: Form validation - empty fields
// ============================================
await runTest('Login validation - empty fields', async () => {
  await element('login-btn').tap();
  await element('email-error').toBeVisible();
});

// ============================================
// TEST: Form validation - invalid email
// ============================================
await runTest('Login validation - invalid email', async () => {
  await element('email-input').tap();
  await element('email-input').typeText('invalid-email');
  await element('password-input').tap();
  await element('password-input').typeText('password123');
  await element('login-btn').tap();
  await element({ text: 'Invalid email' }).toBeVisible();
});

// ============================================
// TEST: Navigate to registration
// ============================================
await runTest('Navigate to registration', async () => {
  await element('go-to-register').tap();
  await element('register-screen').toBeVisible();
});

// ============================================
// TEST: Registration form validation
// ============================================
await runTest('Registration validation - empty fields', async () => {
  await element('register-btn').tap();
  await element('name-error').toBeVisible();
});

await runTest('Registration validation - password too short', async () => {
  await element('name-input').tap();
  await element('name-input').typeText('Test User');

  await element('email-input').tap();
  await element('email-input').typeText('test@example.com');

  await element('password-input').tap();
  await element('password-input').typeText('short');

  await element('register-btn').tap();
  await element({ text: { pattern: 'at least 8', mode: 'contains' } }).toBeVisible();
});

// ============================================
// TEST: Complete registration
// ============================================
await runTest('Complete registration', async () => {
  await element('password-input').clearText();
  await element('password-input').typeText('password123');

  await element('confirm-password-input').tap();
  await element('confirm-password-input').typeText('password123');

  await element('accept-terms').tap();
  await element('register-btn').tap();

  await element('home-screen').toBeVisible();
  await element({ text: { pattern: 'Hello, Test', mode: 'contains' } }).toBeVisible();
});

// ============================================
// TEST: Profile screen shows user info
// ============================================
await runTest('Profile shows user info', async () => {
  await goProfile();
  await element('profile-screen').toBeVisible();
  await element({ text: 'Test User' }).toBeVisible();
});

// ============================================
// TEST: Logout flow
// ============================================
await runTest('Logout flow', async () => {
  await element('menu-logout').tap();
  await element({ text: 'Sign Out' }).toBeVisible();
  await element({ text: 'Sign Out' }).tap();
  await element('guest-view').toBeVisible();
});

// ============================================
// TEST: Demo login
// ============================================
await runTest('Demo login', async () => {
  await goHome();
  await element('home-signin-btn').tap();
  await element('login-screen').toBeVisible();
  await element('demo-login-btn').tap();
  await element('home-screen').toBeVisible();
  await element({ text: { pattern: 'Hello, John', mode: 'contains' } }).toBeVisible();
});

console.log('\n✅ Auth flow tests completed!');
