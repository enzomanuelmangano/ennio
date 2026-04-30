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
  // Alert/Modal API
  Alert,
  isAlertPresent,
  getAlertText,
  getAlertButtons,
  tapAlertButton,
  dismissAlert,
  waitForAlert,
} from './api';

// Launcher
export {
  launchIOS,
  launchAndroid,
  getIOSSimulators,
  getAndroidEmulators,
  waitForTastoServer,
  findSimulator,
  bootSimulator,
  installAppIOS,
  launchAppIOS,
  terminateAppIOS,
} from './launcher';

// Config
export { loadConfig, defineConfig } from './config';

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

export type {
  IOSLaunchOptions,
  AndroidLaunchOptions,
  LaunchResult,
} from './launcher';

export type {
  TastoConfig,
  IOSConfig,
  AndroidConfig,
} from './config';
