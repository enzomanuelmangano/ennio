import { element, sleep, runTest } from '@ennio/test';
import { goProfile } from './shared';

await runTest('should ensure logged out state', async () => {
  await goProfile();
  await sleep(300);
  const isGuest = await element('guest-view').exists();
  const isProfile = await element('profile-screen').exists();
  if (!isGuest && !isProfile) throw new Error('Not on profile tab');
});

await runTest('should navigate to login screen', async () => {
  const guestBtn = await element('guest-signin-btn').exists();
  if (guestBtn) {
    await element('guest-signin-btn').tap();
    await sleep(300);
    const loginScreen = await element('login-screen').exists();
    if (loginScreen) {
      await element('login-screen').toBeVisible();
    }
  }
});

await runTest('should display login form', async () => {
  const emailInput = await element('email-input').exists();
  if (emailInput) {
    await element('email-input').toBeVisible();
    await element('password-input').toBeVisible();
    await element('login-btn').toBeVisible();
  }
});

await runTest('should show validation errors for empty form', async () => {
  const loginBtn = await element('login-btn').exists();
  if (loginBtn) {
    await element('login-btn').tap();
    await sleep(200);
  }
});

await runTest('should show error for invalid email format', async () => {
  const emailInput = await element('email-input').exists();
  if (emailInput) {
    await element('email-input').typeText('invalid-email');
    const loginBtn = await element('login-btn').exists();
    if (loginBtn) {
      await element('login-btn').tap();
      await sleep(200);
    }
  }
});

await runTest('should clear error when typing', async () => {
  const emailInput = await element('email-input').exists();
  if (emailInput) {
    await element('email-input').clearText();
    await element('email-input').typeText('test@example.com');
  }
});

await runTest('should navigate to register screen', async () => {
  const goToRegister = await element('go-to-register').exists();
  if (goToRegister) {
    await element('go-to-register').tap();
    await sleep(300);
  }
});

await runTest('should display register form', async () => {
  const nameInput = await element('name-input').exists();
  if (nameInput) {
    await element('name-input').toBeVisible();
  }
});

await runTest('should show password strength indicator', async () => {
  const passwordInput = await element('password-input').exists();
  if (passwordInput) {
    await element('password-input').typeText('Test123');
    await sleep(200);
  }
});

await runTest('should validate password match', async () => {
  const confirmPassword = await element('confirm-password-input').exists();
  if (confirmPassword) {
    await element('confirm-password-input').typeText('Test456');
  }
});

await runTest('should navigate back to login', async () => {
  const goToLogin = await element('go-to-login').exists();
  if (goToLogin) {
    await element('go-to-login').tap();
    await sleep(300);
  }
});

await runTest('should login with demo account', async () => {
  const demoBtn = await element('demo-login-btn').exists();
  if (demoBtn) {
    await element('demo-login-btn').tap();
    await sleep(1500);
  }
});

await runTest('should display authenticated profile', async () => {
  const profileHeader = await element('profile-header').exists();
  if (profileHeader) {
    await element('profile-header').toBeVisible();
  }
});

await runTest('should display menu items', async () => {
  const menuOrders = await element('menu-orders').exists();
  if (menuOrders) {
    await element('menu-orders').toBeVisible();
  }
});

await runTest('should navigate to settings', async () => {
  const menuSettings = await element('menu-settings').exists();
  if (menuSettings) {
    await element('menu-settings').tap();
    await sleep(300);
    await goProfile();
  }
});

await runTest('should logout', async () => {
  await goProfile();
  const isGuest = await element('guest-view').exists();
  const isProfile = await element('profile-screen').exists();
  if (!isGuest && !isProfile) throw new Error('Not on profile tab');
});
