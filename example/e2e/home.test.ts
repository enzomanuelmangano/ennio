import {
  element,
  waitForElement,
  waitForVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest } from './setup';

/**
 * Home Screen E2E Tests
 *
 * Tests navigation and basic UI rendering
 */
export default async function homeTests(): Promise<void> {
  await setup();

  try {
    await runTest('should display home screen', async () => {
      await element('home-screen').toBeVisible();
      await element('home-title').toHaveText('Welcome to Tasto');
      await element('home-subtitle').toContainText('E2E Testing');
    });

    await runTest('should display all navigation buttons', async () => {
      await element('nav-form-btn').toBeVisible();
      await element('nav-list-btn').toBeVisible();
      await element('nav-modal-btn').toBeVisible();
    });

    await runTest('should navigate to form screen', async () => {
      await element('nav-form-btn').tap();
      await waitForVisible('form-screen');
      await element('form-title').toHaveText('Create Account');

      // Navigate back
      // Note: In real tests, you'd use navigation helpers
      await sleep(500);
    });

    await runTest('should navigate to list screen', async () => {
      // First go back to home if needed
      await waitForElement('home-screen', { timeout: 2000 }).catch(() => {});

      await element('nav-list-btn').tap();
      await waitForVisible('list-screen');
      await element('list-count').toContainText('100 items');

      await sleep(500);
    });

    await runTest('should navigate to modal screen', async () => {
      // First go back to home if needed
      await waitForElement('home-screen', { timeout: 2000 }).catch(() => {});

      await element('nav-modal-btn').tap();
      await waitForVisible('modal-screen');

      await sleep(500);
    });

    await runTest('should display info box', async () => {
      // Go back to home
      await waitForElement('home-screen', { timeout: 2000 }).catch(() => {});

      await element('info-box').toBeVisible();
      await element('info-box').toContainText('E2E testing capabilities');
    });
  } finally {
    teardown();
  }
}

// Export individual test functions for selective running
export async function testHomeScreenDisplay(): Promise<void> {
  await element('home-screen').toBeVisible();
  await element('home-title').toHaveText('Welcome to Tasto');
}

export async function testNavigationButtons(): Promise<void> {
  await element('nav-form-btn').toBeVisible();
  await element('nav-list-btn').toBeVisible();
  await element('nav-modal-btn').toBeVisible();
}
