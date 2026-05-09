import { NitroModules } from 'react-native-nitro-modules';
import type {
  Ennio,
  ElementInfo,
  ExtendedElementInfo,
  LayoutMetrics,
  Selector,
  TextMatcher,
  TextMatchMode,
  Point,
  Trait,
  ScrollDirection,
} from './Ennio.nitro';

export type {
  Ennio,
  ElementInfo,
  ExtendedElementInfo,
  LayoutMetrics,
  Selector,
  TextMatcher,
  TextMatchMode,
  Point,
  Trait,
  ScrollDirection,
};

/**
 * Default WebSocket server port
 */
export const DEFAULT_PORT = 9876;

let _ennioModule: Ennio | null = null;
let _initError: Error | null = null;

/**
 * Get the Ennio HybridObject instance
 * This provides direct access to the native Fabric shadow tree
 */
export function getEnnioModule(): Ennio | null {
  if (_ennioModule) {
    return _ennioModule;
  }

  if (_initError) {
    return null;
  }

  try {
    _ennioModule = NitroModules.createHybridObject<Ennio>('Ennio');
    return _ennioModule;
  } catch (error) {
    _initError = error instanceof Error ? error : new Error(String(error));
    if (__DEV__) {
      console.warn('[Ennio] Native module not available:', _initError.message);
      console.warn('[Ennio] E2E testing features will be disabled');
    }
    return null;
  }
}

/**
 * Check if the native module is available
 */
export function isNativeModuleAvailable(): boolean {
  return getEnnioModule() !== null;
}

/**
 * Start the Ennio test server
 * @param port - Port number (default: 9876)
 */
export function startServer(port: number = DEFAULT_PORT): void {
  const module = getEnnioModule();
  if (module) {
    module.startServer(port);
  }
}

/**
 * Stop the Ennio test server
 */
export function stopServer(): void {
  const module = getEnnioModule();
  if (module) {
    module.stopServer();
  }
}

/**
 * Check if the server is running
 */
export function isServerRunning(): boolean {
  const module = getEnnioModule();
  return module ? module.isServerRunning() : false;
}

// For backwards compatibility
export const EnnioModule = {
  get startServer() {
    return startServer;
  },
  get stopServer() {
    return stopServer;
  },
  get isServerRunning() {
    return isServerRunning;
  },
};

// No JS-side bootstrap. `@ennio/core` autolinks via Pod, and the iOS
// `EnnioAutoInit` swizzle drives the WS-server start + Fiber walker
// install + HybridEnnio construction natively, on the JS thread, the
// moment RCTHost finishes booting. The user's app never imports this
// package; it lands purely through `npm install @ennio/core`.
