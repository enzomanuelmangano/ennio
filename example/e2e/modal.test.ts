import {
  element,
  waitForVisible,
  waitForNotVisible,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goHome } from './setup.ts';

/**
 * Modal Screen E2E Tests
 *
 * Tests modal opening, closing, and interaction
 */
export default async function modalTests(): Promise<void> {
  await setup();
  await goHome();

  try {
    // Navigate to modal screen first
    await element('nav-modal-btn').tap();
    await waitForVisible('modal-screen');

    await runTest('should display modal buttons', async () => {
      await element('open-confirm-modal-btn').toBeVisible();
      await element('open-alert-modal-btn').toBeVisible();
    });

    // ============================================
    // Confirmation Modal Tests
    // ============================================

    await runTest('should open confirmation modal', async () => {
      await element('open-confirm-modal-btn').tap();
      await waitForVisible('confirm-modal', { timeout: 1000 });

      await element('confirm-modal-title').toHaveText('Confirm Action');
      await element('confirm-modal-message').toContainText('Are you sure');
    });

    await runTest('should close confirmation modal on cancel', async () => {
      // Modal should still be open from previous test
      await element('confirm-modal-cancel-btn').tap();

      // Wait for last action container to appear (means modal closed and state updated)
      await waitForVisible('last-action-container', { timeout: 2000 });

      // Last action should show cancelled
      await element('last-action-text').toHaveText('Cancelled');
    });

    await runTest('should close confirmation modal on confirm', async () => {
      // Open modal again
      await element('open-confirm-modal-btn').tap();
      await waitForVisible('confirm-modal', { timeout: 1000 });

      // Click confirm
      await element('confirm-modal-confirm-btn').tap();

      // Wait for state to update
      await waitForVisible('last-action-container', { timeout: 2000 });

      // Last action should show confirmed
      await element('last-action-text').toHaveText('Confirmed!');
    });

    // ============================================
    // Alert Modal Tests
    // ============================================

    await runTest('should open alert modal', async () => {
      await element('open-alert-modal-btn').tap();
      await waitForVisible('alert-modal', { timeout: 1000 });

      await element('alert-modal-title').toHaveText('Important Notice');
      await element('alert-modal-message').toContainText('important alert');
    });

    await runTest('should dismiss alert modal', async () => {
      // Modal should still be open
      await element('alert-modal-dismiss-btn').tap();

      // Wait for state to update
      await waitForVisible('last-action-container', { timeout: 2000 });

      await element('last-action-text').toHaveText('Alert dismissed');
    });
  } finally {
    teardown();
  }
}

// Export individual test functions
export async function testConfirmationModal(): Promise<void> {
  await element('open-confirm-modal-btn').tap();
  await waitForVisible('confirm-modal', { timeout: 1000 });
  await element('confirm-modal-confirm-btn').tap();
}

export async function testAlertModal(): Promise<void> {
  await element('open-alert-modal-btn').tap();
  await waitForVisible('alert-modal', { timeout: 1000 });
  await element('alert-modal-dismiss-btn').tap();
}
