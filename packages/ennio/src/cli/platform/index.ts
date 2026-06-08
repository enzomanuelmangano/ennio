import { AndroidPlatform } from './android';
import { IosPlatform } from './ios';
import type { Platform } from './types';

export type { Platform, DeviceSession, ConnectOptions, OpenConnection } from './types';
export { IosPlatform } from './ios';
export { AndroidPlatform } from './android';

export type PlatformName = 'ios' | 'android';

/** Construct the backend for a run. Chosen once in commands/test.ts. */
export function selectPlatform(name: PlatformName): Platform {
  return name === 'android' ? new AndroidPlatform() : new IosPlatform();
}
