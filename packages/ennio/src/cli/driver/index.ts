import { AndroidDriver } from './android-driver';
import { FastDriver } from './fast-driver';
import { HidDriver } from './hid-driver';
import type { GestureDriver } from './types';

export type { GestureDriver, PreTapSnapshot, SwipeOutcome, TapIntent, TapOptions } from './types';
export { HidDriver } from './hid-driver';
export { FastDriver } from './fast-driver';
export { AndroidDriver } from './android-driver';

/** iOS gesture mode, decided exactly once. */
export function createDriver(fast: boolean): GestureDriver {
  const hid = new HidDriver();
  return fast ? new FastDriver(hid) : hid;
}

/** Android in-process MotionEvent driver. */
export function createAndroidDriver(): GestureDriver {
  return new AndroidDriver();
}
