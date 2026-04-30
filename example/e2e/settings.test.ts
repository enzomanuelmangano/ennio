import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goProfile, goHome } from './setup';

/**
 * Settings Screen E2E Tests
 *
 * Tests settings toggles and preferences
 */
export default async function settingsTests(): Promise<void> {
  await setup();

  try {
    await runTest('should navigate to settings', async () => {
      await goProfile();
      // Try guest navigation first
      const guestView = await element('guest-view').exists();
      if (guestView) {
        await goHome();
        await element('quick-action-settings').tap();
      } else {
        await element('menu-settings').tap();
      }
      await waitForVisible('settings-screen');
    });

    await runTest('should display appearance settings', async () => {
      await element('toggle-dark-mode').toBeVisible();
      await element('toggle-haptic').toBeVisible();
      await element('toggle-badges').toBeVisible();
    });

    await runTest('should toggle dark mode', async () => {
      await element('toggle-dark-mode').tap();
      await sleep(300); // Wait for theme to apply
      // Toggle back
      await element('toggle-dark-mode').tap();
      await sleep(300);
    });

    await runTest('should toggle haptic feedback', async () => {
      await element('toggle-haptic').tap();
      await sleep(100);
    });

    await runTest('should display notification settings', async () => {
      await element('toggle-order-updates').toBeVisible();
      await element('toggle-promotions').toBeVisible();
      await element('toggle-new-arrivals').toBeVisible();
      await element('toggle-price-drops').toBeVisible();
    });

    await runTest('should toggle notifications', async () => {
      await element('toggle-promotions').tap();
      await sleep(100);
      await element('toggle-promotions').tap();
      await sleep(100);
    });

    await runTest('should display privacy settings', async () => {
      await element('toggle-analytics').toBeVisible();
      await element('toggle-personalized-ads').toBeVisible();
      await element('toggle-location').toBeVisible();
    });

    await runTest('should toggle privacy settings', async () => {
      await element('toggle-analytics').tap();
      await sleep(100);
    });

    await runTest('should display about section', async () => {
      await element('app-version').toBeVisible();
      await element('terms').toBeVisible();
      await element('privacy-policy').toBeVisible();
      await element('help').toBeVisible();
    });

    await runTest('should display data management options', async () => {
      await element('clear-data').toBeVisible();
      await element('reset-settings').toBeVisible();
    });
  } finally {
    teardown();
  }
}
