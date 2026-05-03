import { element, sleep, runTest } from '@ennio/test';
import { goHome, goProducts } from './shared';

await runTest('should see home screen', async () => {
  await goHome();
  await element('home-screen').toBeVisible();
});

await runTest('should tap products tab', async () => {
  await element('tab-products').tap();
  await sleep(500);
  await element('products-screen').toBeVisible();
});

await runTest('should go back to home', async () => {
  await goHome();
  await element('home-screen').toBeVisible();
});
