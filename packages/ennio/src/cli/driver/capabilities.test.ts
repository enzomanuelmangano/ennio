import { describe, it, expect } from 'vitest';

import { AndroidDriver, FastDriver, HidDriver } from './index';

// Pin the tap-delivery capability that gates the self-heal retap. A
// deterministic in-process driver must NOT retap (it would double-fire
// onPress — see the react-navigation preload-flow double-timer bug); a
// driver whose taps can physically miss MUST keep the retap.
describe('GestureDriver.deterministicTaps', () => {
  it('is true for the in-process Android driver', () => {
    expect(new AndroidDriver().deterministicTaps).toBe(true);
  });

  it('is false for the out-of-process HID driver', () => {
    expect(new HidDriver().deterministicTaps).toBe(false);
  });

  it('is false for the Fast driver (general taps wrap HID, which can miss)', () => {
    expect(new FastDriver(new HidDriver()).deterministicTaps).toBe(false);
  });
});
