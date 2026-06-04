import { FastDriver } from './fast-driver';
import { HidDriver } from './hid-driver';
import type { GestureDriver } from './types';

export type { GestureDriver, PreTapSnapshot, SwipeOutcome, TapIntent, TapOptions } from './types';
export { HidDriver } from './hid-driver';
export { FastDriver } from './fast-driver';

/** Mode is decided exactly once, here. */
export function createDriver(fast: boolean): GestureDriver {
  const hid = new HidDriver();
  return fast ? new FastDriver(hid) : hid;
}
