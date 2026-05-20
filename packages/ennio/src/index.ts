import { NitroModules } from 'react-native-nitro-modules';
import type {
  Ennio,
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
  ExtendedElementInfo,
  LayoutMetrics,
  Selector,
  TextMatcher,
  TextMatchMode,
  Point,
  Trait,
  ScrollDirection,
};

let _ennioModule: Ennio | null = null;
let _initError: Error | null = null;

/**
 * Get the Ennio HybridObject instance. Auto-init happens at app start
 * (EnnioAutoInit swizzles RCTHost.start) — this is just a stable
 * handle for callers that want to introspect from JS.
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
 * Returns true when the Ennio JSI surface is reachable. The runtime
 * dispatch surface (`__ennioDispatch` + commit signal) is installed
 * automatically by the pod's `+load` hook — this only exposes the
 * Nitro module to JS callers that want to read state directly.
 */
export function isNativeModuleAvailable(): boolean {
  return getEnnioModule() !== null;
}

/**
 * Register an app-side reset callback used by ennio's `clearState` fast
 * path. When set, the CLI runs this function in-process between flows
 * instead of doing a full `simctl terminate` + `simctl launch` cycle.
 *
 * The function is responsible for bringing the app back to its
 * canonical "fresh launch" state in whatever way fits the app:
 *   - Zustand: `store.setState(store.getInitialState?.() ?? initial)`
 *   - Redux: dispatch a reset action
 *   - AsyncStorage: `AsyncStorage.clear()`
 *   - Navigation: pop / reset stack to root
 *
 * Why this matters:
 *   ennio's default `clearState` path destroys the JS context (process
 *   restart or `RCTReloadCommand`) — guaranteed clean state at the cost
 *   of ~5-6s per reset (process spawn + Hermes bundle re-execute +
 *   Inspector reconnect). A registered reset runs in the SAME JS
 *   context with no reload, no reconnect — typically ~150-500ms.
 *
 * Opt-in: ennio detects whether the callback was registered at runtime
 * (`globalThis.__ennioReset`). Apps that don't register one fall back
 * to the existing slow-path clearState. Same YAML syntax in both cases.
 *
 * Example:
 *   import { registerEnnioReset } from '@reactiive/ennio';
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   import { useCartStore, useUserStore } from './store';
 *   import { router } from 'expo-router';
 *
 *   registerEnnioReset(async () => {
 *     useCartStore.setState(useCartStore.getInitialState());
 *     useUserStore.setState(useUserStore.getInitialState());
 *     await AsyncStorage.clear();
 *     router.replace('/');
 *   });
 */
export function registerEnnioReset(fn: () => void | Promise<void>): void {
  (globalThis as unknown as { __ennioReset?: () => void | Promise<void> }).__ennioReset = fn;
}

// No JS-side bootstrap. `ennio` autolinks via Pod, and the iOS
// `EnnioAutoInit` swizzle installs the JSI dispatch surface (commit
// signal + `__ennioDispatch` host function) natively, on the JS
// thread, the moment RCTHost finishes booting. The user's app never
// imports this package; it lands purely through `npm install ennio`.
// The external CLI drives the runtime via Hermes Inspector
// (`Runtime.evaluate('__ennioDispatch(...)')`).
