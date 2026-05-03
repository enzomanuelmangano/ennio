/**
 * Device Control Module
 *
 * Unified API for controlling iOS simulators and physical devices.
 * Supports app lifecycle operations (launch, terminate, clear state)
 * on both simulator and physical devices.
 */

import { execSync, spawnSync } from 'child_process';

// ============================================
// Types
// ============================================

export type DeviceType = 'simulator' | 'physical';

export interface DeviceInfo {
  id: string;
  type: DeviceType;
  name?: string;
}

// ============================================
// Device Detection
// ============================================

/**
 * Get the booted iOS simulator device ID
 */
export function getBootedSimulatorId(): string | null {
  try {
    const output = execSync('xcrun simctl list devices booted -j', { encoding: 'utf-8', stdio: 'pipe' });
    const data = JSON.parse(output);
    for (const runtime of Object.values(data.devices) as Array<Array<{ udid: string; state: string }>>) {
      for (const device of runtime) {
        if (device.state === 'Booted') {
          return device.udid;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get a connected physical iOS device ID
 */
export function getConnectedPhysicalDeviceId(): string | null {
  try {
    // Try idevice_id from libimobiledevice
    const output = execSync('idevice_id -l', { encoding: 'utf-8', stdio: 'pipe' });
    const lines = output.trim().split('\n').filter((l) => l.trim());
    return lines.length > 0 ? lines[0].trim() : null;
  } catch {
    // idevice_id not installed or no device connected
    return null;
  }
}

/**
 * Get the current device (prefers simulator, falls back to physical)
 */
export function getCurrentDevice(): DeviceInfo | null {
  const simId = getBootedSimulatorId();
  if (simId) {
    return { id: simId, type: 'simulator' };
  }

  const physicalId = getConnectedPhysicalDeviceId();
  if (physicalId) {
    return { id: physicalId, type: 'physical' };
  }

  return null;
}

// ============================================
// App Lifecycle - Simulator
// ============================================

function simLaunchApp(deviceId: string, appId: string): void {
  execSync(`xcrun simctl launch ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
}

function simTerminateApp(deviceId: string, appId: string): void {
  try {
    execSync(`xcrun simctl terminate ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // App may not be running - that's OK
  }
}

function simClearAppState(deviceId: string, appId: string): void {
  // Terminate first
  simTerminateApp(deviceId, appId);

  try {
    // Get app data container path
    const dataContainer = execSync(
      `xcrun simctl get_app_container ${deviceId} ${appId} data`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    if (dataContainer) {
      // Clear Library (AsyncStorage, UserDefaults, etc.)
      execSync(`rm -rf "${dataContainer}/Library"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
      // Clear Documents
      execSync(`rm -rf "${dataContainer}/Documents"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
      // Clear tmp
      execSync(`rm -rf "${dataContainer}/tmp"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
    }

    // Also reset privacy permissions
    execSync(`xcrun simctl privacy ${deviceId} reset all ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // Continue even if some commands fail
  }
}

// ============================================
// App Lifecycle - Physical Device
// ============================================

/**
 * Check if libimobiledevice tools are available
 */
function hasIdeviceTools(): boolean {
  try {
    execSync('which ideviceinstaller', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ios-deploy is available
 */
function hasIosDeploy(): boolean {
  try {
    execSync('which ios-deploy', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function physicalLaunchApp(deviceId: string, appId: string): void {
  if (hasIosDeploy()) {
    // ios-deploy can launch apps
    execSync(`ios-deploy --id ${deviceId} --bundle_id ${appId} --justlaunch`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } else if (hasIdeviceTools()) {
    // idevicedebug can launch apps
    try {
      execSync(`idevicedebug -u ${deviceId} run ${appId}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // idevicedebug may timeout but app still launches
    }
  } else {
    throw new Error('Physical device launch requires ios-deploy or libimobiledevice tools');
  }
}

function physicalTerminateApp(deviceId: string, appId: string): void {
  // There's no direct way to terminate an app on a physical device without debugging tools
  // ios-deploy doesn't support terminate
  // Best effort: do nothing and let the app continue
  console.warn(`Note: Cannot terminate app on physical device without debugger`);
}

function physicalClearAppState(deviceId: string, appId: string): void {
  // On physical devices, we can't access the data container directly
  // The only way to clear state is to uninstall and reinstall the app
  // This is how Maestro handles it too

  if (hasIdeviceTools()) {
    try {
      // Get app path first
      const appListOutput = execSync(`ideviceinstaller -u ${deviceId} -l`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      // Check if app is installed
      if (appListOutput.includes(appId)) {
        console.log(`Reinstalling app to clear state on physical device...`);
        // Note: We can't reinstall without the IPA file
        // User needs to manually clear app data or reinstall
        console.warn(`Warning: Cannot clear app state on physical device. Please reinstall the app manually.`);
      }
    } catch {
      console.warn(`Warning: Could not check app installation status on physical device`);
    }
  } else {
    console.warn(`Warning: libimobiledevice tools not installed. Cannot clear app state on physical device.`);
  }
}

// ============================================
// Unified API
// ============================================

/**
 * Launch an app on the current device
 */
export function launchApp(appId: string, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available (neither simulator nor physical)');
  }

  if (target.type === 'simulator') {
    simLaunchApp(target.id, appId);
  } else {
    physicalLaunchApp(target.id, appId);
  }
}

/**
 * Terminate an app on the current device
 */
export function terminateApp(appId: string, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    simTerminateApp(target.id, appId);
  } else {
    physicalTerminateApp(target.id, appId);
  }
}

/**
 * Clear app state on the current device
 */
export function clearAppState(appId: string, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    simClearAppState(target.id, appId);
  } else {
    physicalClearAppState(target.id, appId);
  }
}

/**
 * Open a URL on the current device
 */
export function openUrl(url: string, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    execSync(`xcrun simctl openurl ${target.id} "${url}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    // For physical devices, use idevicedebug with open URL scheme
    // This is limited - not all URLs will work
    console.warn(`Note: Opening URLs on physical device may not work for all URL types`);
    try {
      execSync(`idevicedebug -u ${target.id} run com.apple.mobilesafari --args "${url}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // May timeout but still work
    }
  }
}

/**
 * Take a screenshot on the current device
 */
export function takeScreenshot(path: string, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    execSync(`xcrun simctl io ${target.id} screenshot "${path}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    // Use idevicescreenshot from libimobiledevice
    if (hasIdeviceTools()) {
      execSync(`idevicescreenshot -u ${target.id} "${path}"`, { encoding: 'utf-8', stdio: 'pipe' });
    } else {
      throw new Error('Physical device screenshot requires libimobiledevice tools (idevicescreenshot)');
    }
  }
}

/**
 * Set location on the current device (simulator only)
 */
export function setLocation(latitude: number, longitude: number, device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    execSync(`xcrun simctl location ${target.id} set ${latitude},${longitude}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } else {
    console.warn(`Note: Setting location on physical device is not supported`);
  }
}

/**
 * Add media to the device (simulator only)
 */
export function addMedia(files: string[], device?: DeviceInfo): void {
  const target = device || getCurrentDevice();
  if (!target) {
    throw new Error('No iOS device available');
  }

  if (target.type === 'simulator') {
    for (const file of files) {
      execSync(`xcrun simctl addmedia ${target.id} "${file}"`, { encoding: 'utf-8', stdio: 'pipe' });
    }
  } else {
    console.warn(`Note: Adding media to physical device is not supported`);
  }
}
