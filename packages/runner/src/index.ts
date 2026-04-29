// Client
export { TastoClient, getClient, connect, disconnect } from './client';

// API
export {
  Element,
  element,
  expect,
  waitFor,
  waitForElement,
  waitForVisible,
  waitForNotExist,
  waitForNotVisible,
  synchronize,
  waitForIdle,
  sleep,
  configure,
} from './api';

// Types
export type {
  LayoutMetrics,
  ElementInfo,
  ScrollDirection,
  TastoRequest,
  TastoResponse,
  ConnectionOptions,
  TestConfig,
  TestResult,
  TestSuiteResult,
} from './types';
