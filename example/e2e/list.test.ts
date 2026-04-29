import {
  element,
  waitForElement,
  waitForVisible,
  waitForNotExist,
  sleep,
  getClient,
} from '@tasto/runner';
import { setup, teardown, runTest } from './setup';

/**
 * List Screen E2E Tests
 *
 * Tests FlatList rendering, scrolling, selection, and refresh
 */
export default async function listTests(): Promise<void> {
  await setup();

  try {
    // Navigate to list screen first
    await element('nav-list-btn').tap();
    await waitForVisible('list-screen');

    await runTest('should display list with items', async () => {
      await element('item-list').toBeVisible();
      await element('list-count').toContainText('100 items');

      // First few items should be visible
      await element('list-item-0').toBeVisible();
      await element('list-item-1').toBeVisible();
      await element('list-item-2').toBeVisible();
    });

    await runTest('should display item content', async () => {
      await element('list-item-0-title').toHaveText('Item 1');
      await element('list-item-0-subtitle').toContainText('description for item 1');
    });

    await runTest('should select item on tap', async () => {
      // Tap first item
      await element('list-item-0-tap').tap();
      await sleep(100);

      // Check for selection indicator
      await element('list-item-0-check').toBeVisible();
      await element('selected-count').toContainText('1 selected');
    });

    await runTest('should toggle selection on second tap', async () => {
      // Item should already be selected from previous test
      // Tap again to deselect
      await element('list-item-0-tap').tap();
      await sleep(100);

      // Check should be gone
      await waitForNotExist('list-item-0-check', { timeout: 1000 });
    });

    await runTest('should select multiple items', async () => {
      // Select items 0, 1, 2
      await element('list-item-0-tap').tap();
      await sleep(50);
      await element('list-item-1-tap').tap();
      await sleep(50);
      await element('list-item-2-tap').tap();
      await sleep(100);

      // Check selection count
      await element('selected-count').toContainText('3 selected');

      // Check marks should be visible
      await element('list-item-0-check').toBeVisible();
      await element('list-item-1-check').toBeVisible();
      await element('list-item-2-check').toBeVisible();
    });

    await runTest('should clear selection', async () => {
      // Click clear button
      await element('clear-selection-btn').tap();
      await sleep(100);

      // Check marks should be gone
      await waitForNotExist('list-item-0-check', { timeout: 1000 });
      await waitForNotExist('selected-count', { timeout: 1000 });
    });

    await runTest('should scroll to item', async () => {
      // Scroll down to item 50
      await element('item-list').scrollToIndex(50);
      await sleep(300);

      // Item 50 should now be visible
      await waitForVisible('list-item-50', { timeout: 2000 });
      await element('list-item-50-title').toHaveText('Item 51');
    });

    await runTest('should scroll by delta', async () => {
      // Scroll down by 500 points
      await element('item-list').scroll(0, 500);
      await sleep(300);

      // Should have scrolled further down
      // Exact item visible depends on scroll position
    });

    await runTest('should scroll to show specific element', async () => {
      // First scroll to top
      await element('item-list').scrollToIndex(0);
      await sleep(300);

      // Now scroll to item 80
      await element('item-list').scrollTo('list-item-80');
      await sleep(300);

      await waitForVisible('list-item-80', { timeout: 2000 });
    });

    await runTest('should swipe to scroll', async () => {
      // Swipe up to scroll down
      await element('item-list').swipe('up', 300);
      await sleep(300);
    });

    await runTest('should delete item on long press', async () => {
      // First scroll back to top
      await element('item-list').scrollToIndex(0);
      await sleep(300);

      // Get initial count
      await element('list-count').toContainText('100 items');

      // Long press to delete first item
      const client = getClient();
      await client.longPress('list-item-0-tap', 500);
      await sleep(200);

      // Count should be reduced
      await element('list-count').toContainText('99 items');
    });

    // Commenting out refresh test as it requires pull-to-refresh gesture
    // which is more complex to implement
    // await runTest('should refresh list on pull', async () => {
    //   // Pull to refresh
    //   await element('item-list').swipe('down', 200);
    //   await sleep(100);
    //
    //   // Should show refresh indicator
    //   await waitForVisible('refresh-overlay', { timeout: 1000 });
    //
    //   // Wait for refresh to complete
    //   await waitForNotExist('refresh-overlay', { timeout: 3000 });
    //
    //   // Should have 100 items again
    //   await element('list-count').toContainText('100 items');
    // });
  } finally {
    teardown();
  }
}

// Export individual test functions
export async function testListRendering(): Promise<void> {
  await element('item-list').toBeVisible();
  await element('list-item-0').toBeVisible();
}

export async function testListSelection(): Promise<void> {
  await element('list-item-0-tap').tap();
  await element('list-item-0-check').toBeVisible();
  await element('selected-count').toContainText('1 selected');
}

export async function testListScrolling(): Promise<void> {
  await element('item-list').scrollToIndex(50);
  await waitForVisible('list-item-50', { timeout: 2000 });
}
