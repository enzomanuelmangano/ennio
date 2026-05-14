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

// No JS-side bootstrap. `ennio` autolinks via Pod, and the iOS
// `EnnioAutoInit` swizzle installs the JSI dispatch surface (commit
// signal + `__ennioDispatch` host function) natively, on the JS
// thread, the moment RCTHost finishes booting. The user's app never
// imports this package; it lands purely through `npm install ennio`.
// The external CLI drives the runtime via Hermes Inspector
// (`Runtime.evaluate('__ennioDispatch(...)')`).
