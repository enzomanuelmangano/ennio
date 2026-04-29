/**
 * Layout metrics for a UI element
 */
export interface LayoutMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

/**
 * Information about a found element
 */
export interface ElementInfo {
  testID: string;
  type: string;
  text?: string;
  accessible: boolean;
  enabled: boolean;
  layout: LayoutMetrics;
}

/**
 * Scroll direction for swipe operations
 */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Request sent to the native server
 */
export interface TastoRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Response received from the native server
 */
export interface TastoResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Connection options for the WebSocket client
 */
export interface ConnectionOptions {
  host?: string;
  port?: number;
  timeout?: number;
}

/**
 * Test configuration options
 */
export interface TestConfig {
  defaultTimeout?: number;
  retryCount?: number;
  retryDelay?: number;
  verbose?: boolean;
}

/**
 * Test result
 */
export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: Error;
}

/**
 * Test suite result
 */
export interface TestSuiteResult {
  name: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  duration: number;
}
