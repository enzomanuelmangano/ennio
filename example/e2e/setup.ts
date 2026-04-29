import { connect, disconnect, configure } from '@tasto/runner';

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
