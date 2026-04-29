import { NitroModules } from 'react-native-nitro-modules';
import type { Tasto, ElementInfo, LayoutMetrics, ScrollDirection } from './Tasto.nitro';

export type { Tasto, ElementInfo, LayoutMetrics, ScrollDirection };

/**
 * Default WebSocket server port
 */
export const DEFAULT_PORT = 9876;

let _tastoModule: Tasto | null = null;
let _initError: Error | null = null;

/**
 * Get the Tasto HybridObject instance
 * This provides direct access to the native Fabric shadow tree
 */
export function getTastoModule(): Tasto | null {
  if (_tastoModule) {
    return _tastoModule;
  }

  if (_initError) {
    return null;
  }

  try {
    _tastoModule = NitroModules.createHybridObject<Tasto>('Tasto');
    return _tastoModule;
  } catch (error) {
    _initError = error instanceof Error ? error : new Error(String(error));
    if (__DEV__) {
      console.warn('[Tasto] Native module not available:', _initError.message);
      console.warn('[Tasto] E2E testing features will be disabled');
    }
    return null;
  }
}

/**
 * Check if the native module is available
 */
export function isNativeModuleAvailable(): boolean {
  return getTastoModule() !== null;
}

/**
 * Start the Tasto test server
 * @param port - Port number (default: 9876)
 */
export function startServer(port: number = DEFAULT_PORT): void {
  const module = getTastoModule();
  if (module) {
    module.startServer(port);
  }
}

/**
 * Stop the Tasto test server
 */
export function stopServer(): void {
  const module = getTastoModule();
  if (module) {
    module.stopServer();
  }
}

/**
 * Check if the server is running
 */
export function isServerRunning(): boolean {
  const module = getTastoModule();
  return module ? module.isServerRunning() : false;
}

// For backwards compatibility
export const TastoModule = {
  get startServer() { return startServer; },
  get stopServer() { return stopServer; },
  get isServerRunning() { return isServerRunning; },
};
