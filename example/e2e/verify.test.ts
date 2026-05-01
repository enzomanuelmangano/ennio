import { element, sleep, runTest } from '@tasto/test';

// This test should PASS - home-screen should be visible
await runTest('home screen should be visible', async () => {
  await element('tab-home').tap();
  await sleep(300);
  await element('home-screen').toBeVisible();
});

// This test should FAIL - non-existent element
await runTest('should fail for non-existent element', async () => {
  await element('this-element-does-not-exist-xyz').toBeVisible();
});
