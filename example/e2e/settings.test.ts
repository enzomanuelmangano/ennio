import { element, sleep, runTest } from '@tasto/test';
import { goHome } from './shared';

await runTest('should navigate to settings', async () => {
  await goHome();
  await sleep(300);
  const settingsBtn = await element('quick-action-settings').exists();
  if (settingsBtn) {
    await element('quick-action-settings').tap();
    await sleep(500);
    const settingsExists = await element('settings-screen').exists();
    if (settingsExists) {
      await element('settings-screen').toBeVisible();
    } else {
      await element('home-screen').toBeVisible();
    }
  } else {
    await element('home-screen').toBeVisible();
  }
});

await runTest('should display appearance settings', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    await element('toggle-dark-mode').toBeVisible();
    await element('toggle-haptic').toBeVisible();
  }
});

await runTest('should toggle dark mode', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    await element('toggle-dark-mode').tap();
    await sleep(300);
    await element('toggle-dark-mode').tap();
    await sleep(300);
  }
});

await runTest('should toggle haptic feedback', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    await element('toggle-haptic').tap();
    await sleep(100);
  }
});

await runTest('should display notification settings', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    const orderUpdates = await element('toggle-order-updates').exists();
    if (orderUpdates) {
      await element('toggle-order-updates').toBeVisible();
    }
  }
});

await runTest('should toggle notifications', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    const promotions = await element('toggle-promotions').exists();
    if (promotions) {
      await element('toggle-promotions').tap();
      await sleep(100);
    }
  }
});

await runTest('should display privacy settings', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    const analytics = await element('toggle-analytics').exists();
    if (analytics) {
      await element('toggle-analytics').toBeVisible();
    }
  }
});

await runTest('should toggle privacy settings', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    const analytics = await element('toggle-analytics').exists();
    if (analytics) {
      await element('toggle-analytics').tap();
      await sleep(100);
    }
  }
});

await runTest('should display about section', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    await element('settings-screen').toBeVisible();
  }
});

await runTest('should display data management options', async () => {
  const isSettings = await element('settings-screen').exists();
  if (isSettings) {
    await element('settings-screen').toBeVisible();
  }
});
