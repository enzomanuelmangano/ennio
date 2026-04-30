import {
  element,
  waitForVisible,
  sleep,
  connect,
  disconnect,
} from '@tasto/runner';

export default async function modalDebugTests(): Promise<void> {
  await connect({ host: 'localhost', port: 9876, timeout: 30000 });

  try {
    console.log('=== Modal Debug Test ===\n');

    // Navigate to modal screen
    console.log('1. Navigating to modal screen...');
    await element('nav-modal-btn').tap();
    await waitForVisible('modal-screen');
    console.log('   Modal screen visible\n');

    // Open confirmation modal
    console.log('2. Opening confirmation modal...');
    await element('open-confirm-modal-btn').tap();
    await waitForVisible('confirm-modal');
    console.log('   Confirmation modal visible\n');

    // Get cancel button info
    console.log('3. Getting cancel button info...');
    const cancelBtnInfo = await element('confirm-modal-cancel-btn').getInfo();
    console.log('   Cancel button info:', JSON.stringify(cancelBtnInfo, null, 2));

    const cancelBtnLayout = await element('confirm-modal-cancel-btn').getLayout();
    console.log('   Cancel button layout:', JSON.stringify(cancelBtnLayout, null, 2));

    // Also get confirm button for comparison
    const confirmBtnLayout = await element('confirm-modal-confirm-btn').getLayout();
    console.log('   Confirm button layout:', JSON.stringify(confirmBtnLayout, null, 2));

    // Get overlay info
    const overlayInfo = await element('confirm-modal-overlay').getInfo();
    console.log('   Overlay info:', JSON.stringify(overlayInfo, null, 2));

    // Try tapping confirm button instead (to test if any modal button works)
    console.log('\n4. Tapping confirm button...');
    await element('confirm-modal-confirm-btn').tap();
    await sleep(500);

    // Check if last action appeared
    const lastActionExists = await element('last-action-text').exists();
    console.log('   last-action-text exists:', lastActionExists);

    if (lastActionExists) {
      const text = await element('last-action-text').getText();
      console.log('   last-action-text content:', text);
    }

    console.log('\n=== Debug Test Complete ===');
  } finally {
    disconnect();
  }
}

// Run the test
modalDebugTests().catch(console.error);
