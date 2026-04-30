import { connect, disconnect, configure, element, waitForVisible } from '@tasto/runner';

// Configure defaults
configure({
  defaultTimeout: 10000,
  retryCount: 50,
  retryDelay: 100,
  verbose: false,
});

/**
 * Setup function to run before tests
 */
export async function setup(): Promise<void> {
  await connect({
    host: 'localhost',
    port: 9876,
    timeout: 30000,
  });
}

/**
 * Navigate back to home screen if not already there
 */
export async function goHome(): Promise<void> {
  // Try to detect if we're already on home screen
  const homeExists = await element('home-screen').exists();
  if (homeExists) {
    const isVisible = await element('home-screen').isVisible();
    if (isVisible) {
      return; // Already on home screen
    }
  }

  // Try to tap back button (exists on form, list, modal screens)
  const backExists = await element('back-btn').exists();
  if (backExists) {
    await element('back-btn').tap();
    await waitForVisible('home-screen', { timeout: 3000 });
  }
}

/**
 * Teardown function to run after tests
 */
export function teardown(): void {
  disconnect();
}

/**
 * Helper to run a test with setup/teardown
 */
export async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<void> {
  console.log(`\n▸ ${name}`);
  const startTime = Date.now();

  try {
    await testFn();
    const duration = Date.now() - startTime;
    console.log(`  ✓ Passed (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`  ✗ Failed (${duration}ms)`);
    throw error;
  }
}
