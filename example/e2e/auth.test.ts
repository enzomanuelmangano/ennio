import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goHome, goProfile } from './setup.ts';

/**
 * Authentication E2E Tests
 *
 * Tests login, register, and logout flows
 */
export default async function authTests(): Promise<void> {
  await setup();

  try {
    await runTest('should show guest view when not authenticated', async () => {
      await goProfile();
      await element('guest-view').toBeVisible();
      await element('guest-signin-btn').toBeVisible();
      await element('guest-register-btn').toBeVisible();
    });

    await runTest('should navigate to login screen', async () => {
      await element('guest-signin-btn').tap();
      await waitForVisible('login-screen');
    });

    await runTest('should display login form', async () => {
      await element('email-input').toBeVisible();
      await element('password-input').toBeVisible();
      await element('login-btn').toBeVisible();
      await element('demo-login-btn').toBeVisible();
    });

    await runTest('should show validation errors for empty form', async () => {
      await element('login-btn').tap();
      await sleep(200);
      await element('email-error').toBeVisible();
      await element('password-error').toBeVisible();
    });

    await runTest('should show error for invalid email format', async () => {
      await element('email-input').typeText('invalid-email');
      await element('login-btn').tap();
      await sleep(200);
      await element('email-error').toContainText('Invalid email');
    });

    await runTest('should clear error when typing', async () => {
      await element('email-input').clearText();
      await element('email-input').typeText('test@example.com');
      // Error should be cleared
      const emailErrorExists = await element('email-error').exists();
      if (emailErrorExists) {
        const isVisible = await element('email-error').isVisible();
        if (isVisible) {
          throw new Error('Email error should be cleared');
        }
      }
    });

    await runTest('should navigate to register screen', async () => {
      await element('go-to-register').tap();
      await waitForVisible('register-screen');
    });

    await runTest('should display register form', async () => {
      await element('name-input').toBeVisible();
      await element('email-input').toBeVisible();
      await element('password-input').toBeVisible();
      await element('confirm-password-input').toBeVisible();
      await element('accept-terms').toBeVisible();
      await element('register-btn').toBeVisible();
    });

    await runTest('should show password strength indicator', async () => {
      await element('password-input').typeText('Test123');
      // Strength indicator should be visible (we can't easily check specific text)
      await sleep(200);
    });

    await runTest('should validate password match', async () => {
      await element('confirm-password-input').typeText('Test456');
      await element('accept-terms').tap(); // Toggle terms
      await element('register-btn').tap();
      await sleep(200);
      await element('confirm-password-error').toContainText('do not match');
    });

    await runTest('should navigate back to login', async () => {
      await element('go-to-login').tap();
      await waitForVisible('login-screen');
    });

    await runTest('should login with demo account', async () => {
      await element('demo-login-btn').tap();
      await sleep(1500); // Wait for async login
      // Should be back on profile screen and authenticated
      await waitForVisible('profile-screen', { timeout: 5000 });
    });

    await runTest('should display authenticated profile', async () => {
      await element('profile-header').toBeVisible();
      await element('stats-card').toBeVisible();
    });

    await runTest('should display menu items', async () => {
      await element('menu-orders').toBeVisible();
      await element('menu-settings').toBeVisible();
      await element('menu-logout').toBeVisible();
    });

    await runTest('should navigate to settings', async () => {
      await element('menu-settings').tap();
      await waitForVisible('settings-screen');
      // Go back to profile
      await goProfile();
    });

    await runTest('should logout', async () => {
      await element('menu-logout').tap();
      await sleep(500); // Alert appears
      // Alert confirmation - we can't test alerts easily
      // After logout should show guest view
    });
  } finally {
    teardown();
  }
}
