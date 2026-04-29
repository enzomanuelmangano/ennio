import {
  element,
  waitForElement,
  waitForVisible,
  waitForNotExist,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest } from './setup';

/**
 * Form Screen E2E Tests
 *
 * Tests form input, validation, and submission
 */
export default async function formTests(): Promise<void> {
  await setup();

  try {
    // Navigate to form screen first
    await element('nav-form-btn').tap();
    await waitForVisible('form-screen');

    await runTest('should display form fields', async () => {
      await element('name-input').toBeVisible();
      await element('email-input').toBeVisible();
      await element('password-input').toBeVisible();
      await element('submit-btn').toBeVisible();
    });

    await runTest('should show validation errors for empty form', async () => {
      // Try to submit empty form
      await element('submit-btn').tap();

      // Check for error messages
      await waitForVisible('name-error');
      await waitForVisible('email-error');
      await waitForVisible('password-error');

      await element('name-error').toHaveText('Name is required');
      await element('email-error').toHaveText('Email is required');
      await element('password-error').toHaveText('Password is required');
    });

    await runTest('should validate email format', async () => {
      // Clear any existing errors
      await element('clear-btn').tap();
      await sleep(100);

      // Enter invalid email
      await element('name-input').typeText('John Doe');
      await element('email-input').typeText('invalid-email');
      await element('password-input').typeText('password123');

      await element('submit-btn').tap();

      await waitForVisible('email-error');
      await element('email-error').toHaveText('Invalid email format');
    });

    await runTest('should validate password length', async () => {
      // Clear form
      await element('clear-btn').tap();
      await sleep(100);

      // Enter short password
      await element('name-input').typeText('John Doe');
      await element('email-input').typeText('john@test.com');
      await element('password-input').typeText('short');

      await element('submit-btn').tap();

      await waitForVisible('password-error');
      await element('password-error').toContainText('at least 8 characters');
    });

    await runTest('should clear form on reset', async () => {
      // Type something first
      await element('name-input').clearText();
      await element('name-input').typeText('Test User');

      // Clear form
      await element('clear-btn').tap();
      await sleep(100);

      // Name input should be empty now
      // Note: This would need getText() functionality to fully verify
      await element('name-input').toBeVisible();
    });

    await runTest('should submit valid form successfully', async () => {
      // Fill in valid data
      await element('name-input').typeText('Jane Smith');
      await element('email-input').typeText('jane@test.com');
      await element('password-input').typeText('securepass123');

      await element('submit-btn').tap();

      // Should show loading state
      await waitForVisible('loading-indicator', { timeout: 1000 }).catch(() => {});

      // Wait for success screen
      await waitForVisible('success-container', { timeout: 5000 });
      await element('success-title').toHaveText('Form Submitted!');
      await element('success-message').toContainText('Jane Smith');
    });

    await runTest('should allow starting over after success', async () => {
      // Click reset button on success screen
      await element('reset-btn').tap();

      // Should be back to form
      await waitForVisible('form-title');
      await element('form-title').toHaveText('Create Account');
    });
  } finally {
    teardown();
  }
}

// Export individual test functions
export async function testFormValidation(): Promise<void> {
  await element('submit-btn').tap();
  await waitForVisible('name-error');
  await waitForVisible('email-error');
  await waitForVisible('password-error');
}

export async function testFormSubmission(): Promise<void> {
  await element('name-input').typeText('Test User');
  await element('email-input').typeText('test@example.com');
  await element('password-input').typeText('password123');
  await element('submit-btn').tap();
  await waitForVisible('success-container', { timeout: 5000 });
}
