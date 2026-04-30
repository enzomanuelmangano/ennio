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
 * Navigate to home tab
 */
export async function goHome(): Promise<void> {
  const tabHome = await element('tab-home').exists();
  if (tabHome) {
    await element('tab-home').tap();
    await waitForVisible('home-screen', { timeout: 3000 });
  }
}

/**
 * Navigate to products tab
 */
export async function goProducts(): Promise<void> {
  const tabProducts = await element('tab-products').exists();
  if (tabProducts) {
    await element('tab-products').tap();
    await waitForVisible('products-screen', { timeout: 3000 });
  }
}

/**
 * Navigate to cart tab
 */
export async function goCart(): Promise<void> {
  const tabCart = await element('tab-cart').exists();
  if (tabCart) {
    await element('tab-cart').tap();
    // Could be empty or with items
    await waitForVisible('cart-screen', { timeout: 3000 }).catch(() =>
      waitForVisible('cart-screen-empty', { timeout: 3000 })
    );
  }
}

/**
 * Navigate to profile tab
 */
export async function goProfile(): Promise<void> {
  const tabProfile = await element('tab-profile').exists();
  if (tabProfile) {
    await element('tab-profile').tap();
    // Could be guest view or authenticated
    await waitForVisible('profile-screen', { timeout: 3000 }).catch(() =>
      waitForVisible('guest-view', { timeout: 3000 })
    );
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
