import {
  element,
  waitForElement,
  waitForVisible,
  waitForNotExist,
  sleep,
} from '@tasto/runner';
import { setup, teardown, runTest, goHome } from './setup.ts';

/**
 * List Screen E2E Tests
 *
 * Tests FlatList rendering, scrolling, selection, and refresh
 */
export default async function listTests(): Promise<void> {
  await setup();
  await goHome();

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
      // Tap first item (testID is list-item-0)
      await element('list-item-0').tap();
      await sleep(100);

      // Check for selection indicator
      await element('list-item-0-check').toBeVisible();
      await element('selected-count').toContainText('1 selected');
    });

    await runTest('should toggle selection on second tap', async () => {
      // Item should already be selected from previous test
      // Tap again to deselect
      await element('list-item-0').tap();
      await sleep(100);

      // Check should be gone
      await waitForNotExist('list-item-0-check', { timeout: 1000 });
    });

    await runTest('should select multiple items', async () => {
      // Select items 0, 1, 2
      await element('list-item-0').tap();
      await sleep(50);
      await element('list-item-1').tap();
      await sleep(50);
      await element('list-item-2').tap();
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
