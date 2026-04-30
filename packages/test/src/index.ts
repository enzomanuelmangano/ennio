/**
 * @tasto/test - Simple E2E testing for React Native
 *
 * Uses Nitro for direct shadow tree access.
 */

// Element API
export { Element, element } from './element';

// Utilities
export {
  sleep,
  waitForElement,
  waitForVisible,
  waitForElementToDisappear,
  waitForIdle,
  Alert,
} from './utils';

// Re-export types from nitro
export type { ElementInfo, LayoutMetrics } from '@tasto/nitro';
