import {
  element,
  waitForElement,
  waitForVisible,
  waitForNotVisible,
  waitForNotExist,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest } from './setup';

/**
 * Modal Screen E2E Tests
 *
 * Tests modal opening, closing, and interaction
 */
export default async function modalTests(): Promise<void> {
  await setup();

  try {
    // Navigate to modal screen first
    await element('nav-modal-btn').tap();
    await waitForVisible('modal-screen');

    await runTest('should display modal buttons', async () => {
      await element('open-confirm-modal-btn').toBeVisible();
      await element('open-alert-modal-btn').toBeVisible();
      await element('open-custom-modal-btn').toBeVisible();
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
      await waitForNotVisible('confirm-modal', { timeout: 1000 });

      // Last action should show cancelled
      await element('last-action-text').toHaveText('Cancelled');
    });

    await runTest('should close confirmation modal on confirm', async () => {
      // Open modal again
      await element('open-confirm-modal-btn').tap();
      await waitForVisible('confirm-modal', { timeout: 1000 });

      // Click confirm
      await element('confirm-modal-confirm-btn').tap();
      await waitForNotVisible('confirm-modal', { timeout: 1000 });

      // Last action should show confirmed
      await element('last-action-text').toHaveText('Confirmed!');
    });

    await runTest('should close confirmation modal on overlay tap', async () => {
      // Open modal
      await element('open-confirm-modal-btn').tap();
      await waitForVisible('confirm-modal', { timeout: 1000 });

      // Tap overlay (outside modal content)
      await element('confirm-modal-overlay').tap();
      await waitForNotVisible('confirm-modal', { timeout: 1000 });

      await element('last-action-text').toHaveText('Cancelled');
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
      await waitForNotVisible('alert-modal', { timeout: 1000 });

      await element('last-action-text').toHaveText('Alert dismissed');
    });

    // ============================================
    // Custom Bottom Sheet Modal Tests
    // ============================================

    await runTest('should open custom bottom sheet modal', async () => {
      await element('open-custom-modal-btn').tap();
      await waitForVisible('custom-modal', { timeout: 1000 });

      await element('custom-modal-title').toHaveText('Bottom Sheet Modal');
    });

    await runTest('should display options in bottom sheet', async () => {
      // Modal should still be open
      await element('custom-modal-option-1').toBeVisible();
      await element('custom-modal-option-2').toBeVisible();
      await element('custom-modal-option-3').toBeVisible();
    });

    await runTest('should select option 1', async () => {
      await element('custom-modal-option-1').tap();
      await waitForNotVisible('custom-modal', { timeout: 1000 });

      await element('last-action-text').toHaveText('Option 1 selected');
    });

    await runTest('should select option 2', async () => {
      // Open modal again
      await element('open-custom-modal-btn').tap();
      await waitForVisible('custom-modal', { timeout: 1000 });

      await element('custom-modal-option-2').tap();
      await waitForNotVisible('custom-modal', { timeout: 1000 });

      await element('last-action-text').toHaveText('Option 2 selected');
    });

    await runTest('should close bottom sheet with close button', async () => {
      // Open modal
      await element('open-custom-modal-btn').tap();
      await waitForVisible('custom-modal', { timeout: 1000 });

      await element('custom-modal-close-btn').tap();
      await waitForNotVisible('custom-modal', { timeout: 1000 });

      await element('last-action-text').toHaveText('Custom modal closed');
    });

    await runTest('should close bottom sheet on overlay tap', async () => {
      // Open modal
      await element('open-custom-modal-btn').tap();
      await waitForVisible('custom-modal', { timeout: 1000 });

      // Tap overlay
      await element('custom-modal-overlay').tap();
      await waitForNotVisible('custom-modal', { timeout: 1000 });
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
  await waitForNotVisible('confirm-modal', { timeout: 1000 });
}

export async function testAlertModal(): Promise<void> {
  await element('open-alert-modal-btn').tap();
  await waitForVisible('alert-modal', { timeout: 1000 });
  await element('alert-modal-dismiss-btn').tap();
  await waitForNotVisible('alert-modal', { timeout: 1000 });
}

export async function testBottomSheetModal(): Promise<void> {
  await element('open-custom-modal-btn').tap();
  await waitForVisible('custom-modal', { timeout: 1000 });
  await element('custom-modal-option-1').tap();
  await waitForNotVisible('custom-modal', { timeout: 1000 });
}
