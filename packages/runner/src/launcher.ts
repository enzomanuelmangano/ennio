import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * iOS launch options
 */
export interface IOSLaunchOptions {
  simulator?: string;
  bundleId: string;
  appPath?: string;
  port?: number;
}

/**
 * Android launch options
 */
export interface AndroidLaunchOptions {
  emulator?: string;
  packageName: string;
  apkPath?: string;
  port?: number;
}

/**
 * Result of a launch operation
 */
export interface LaunchResult {
  success: boolean;
  error?: string;
  simulatorId?: string;
  emulatorId?: string;
}

/**
 * Get available iOS simulators
 */
export async function getIOSSimulators(): Promise<
  Array<{ udid: string; name: string; state: string; isAvailable: boolean }>
> {
  try {
    const { stdout } = await execAsync('xcrun simctl list devices -j');
    const data = JSON.parse(stdout);

    const simulators: Array<{
      udid: string;
      name: string;
      state: string;
      isAvailable: boolean;
    }> = [];

    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes('iOS')) continue;
      for (const device of devices as Array<Record<string, unknown>>) {
        simulators.push({
          udid: device.udid as string,
          name: device.name as string,
          state: device.state as string,
          isAvailable: device.isAvailable as boolean,
        });
      }
    }

    return simulators;
  } catch {
    return [];
  }
}

/**
 * Find a simulator by name or UDID
 */
export async function findSimulator(
  nameOrUdid: string
): Promise<{ udid: string; name: string; state: string } | null> {
  const simulators = await getIOSSimulators();

  // Try exact match first
  let match = simulators.find(
    (s) =>
      s.isAvailable &&
      (s.udid === nameOrUdid ||
        s.name.toLowerCase() === nameOrUdid.toLowerCase())
  );

  // Try partial match
  if (!match) {
    match = simulators.find(
      (s) =>
        s.isAvailable && s.name.toLowerCase().includes(nameOrUdid.toLowerCase())
    );
  }

  return match || null;
}

/**
 * Boot an iOS simulator
 */
export async function bootSimulator(simulatorId: string): Promise<boolean> {
  try {
    await execAsync(`xcrun simctl boot "${simulatorId}"`);
    return true;
  } catch (error) {
    // Simulator might already be booted
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Unable to boot device in current state: Booted')) {
      return true;
    }
    return false;
  }
}

/**
 * Install an app on iOS simulator
 */
export async function installAppIOS(
  simulatorId: string,
  appPath: string
): Promise<boolean> {
  try {
    await execAsync(`xcrun simctl install "${simulatorId}" "${appPath}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch an app on iOS simulator
 */
export async function launchAppIOS(
  simulatorId: string,
  bundleId: string
): Promise<boolean> {
  try {
    await execAsync(`xcrun simctl launch "${simulatorId}" "${bundleId}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate an app on iOS simulator
 */
export async function terminateAppIOS(
  simulatorId: string,
  bundleId: string
): Promise<boolean> {
  try {
    await execAsync(`xcrun simctl terminate "${simulatorId}" "${bundleId}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open iOS Simulator.app to show the simulator
 */
export async function openSimulatorApp(): Promise<void> {
  try {
    await execAsync(
      'open -a Simulator'
    );
  } catch {
    // Ignore errors
  }
}

/**
 * Wait for Tasto server to be available
 */
export async function waitForTastoServer(
  port: number,
  timeoutMs: number = 30000
): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const WebSocket = (await import('ws')).default;
      const ws = new WebSocket(`ws://localhost:${port}`);

      return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 2000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
    } catch {
      // Server not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  return false;
}

/**
 * Full iOS launch sequence
 */
export async function launchIOS(options: IOSLaunchOptions): Promise<LaunchResult> {
  const { simulator = 'iPhone 16', bundleId, appPath, port = 9876 } = options;

  // Find simulator
  const sim = await findSimulator(simulator);
  if (!sim) {
    return {
      success: false,
      error: `Simulator "${simulator}" not found. Run "xcrun simctl list devices" to see available simulators.`,
    };
  }

  console.log(`Found simulator: ${sim.name} (${sim.udid})`);

  // Boot if needed
  if (sim.state !== 'Booted') {
    console.log('Booting simulator...');
    const booted = await bootSimulator(sim.udid);
    if (!booted) {
      return {
        success: false,
        error: `Failed to boot simulator ${sim.name}`,
      };
    }

    // Open Simulator.app
    await openSimulatorApp();

    // Wait for boot to complete
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Install app if path provided
  if (appPath) {
    console.log('Installing app...');
    const installed = await installAppIOS(sim.udid, appPath);
    if (!installed) {
      return {
        success: false,
        error: `Failed to install app from ${appPath}`,
      };
    }
  }

  // Launch app
  console.log(`Launching ${bundleId}...`);
  const launched = await launchAppIOS(sim.udid, bundleId);
  if (!launched) {
    return {
      success: false,
      error: `Failed to launch ${bundleId}`,
    };
  }

  // Wait for Tasto server
  console.log(`Waiting for Tasto server on port ${port}...`);
  const serverReady = await waitForTastoServer(port);
  if (!serverReady) {
    return {
      success: false,
      error: `Tasto server did not start within timeout. Make sure TastoProvider is included in your app.`,
    };
  }

  console.log('App launched and Tasto server ready!');
  return {
    success: true,
    simulatorId: sim.udid,
  };
}

/**
 * Get available Android emulators
 */
export async function getAndroidEmulators(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('emulator -list-avds');
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Full Android launch sequence (placeholder)
 */
export async function launchAndroid(
  _options: AndroidLaunchOptions
): Promise<LaunchResult> {
  return {
    success: false,
    error:
      'Android launching not yet implemented. Please start the emulator and app manually.',
  };
}
