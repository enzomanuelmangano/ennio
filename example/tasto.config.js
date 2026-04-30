/**
 * Tasto E2E Testing Configuration
 *
 * @type {import('@tasto/runner').TastoConfig}
 */
module.exports = {
  // WebSocket server port
  port: 9876,

  // Default test timeout in milliseconds
  timeout: 30000,

  // Test file patterns
  testMatch: ['e2e/**/*.test.{ts,js}'],

  // iOS configuration
  ios: {
    // Simulator name or UDID
    simulator: 'iPhone 16',

    // App bundle identifier
    bundleId: 'com.example.tasto',

    // Path to .app bundle (relative to project root)
    appPath: './ios/build/Build/Products/Debug-iphonesimulator/TastoExample.app',
  },

  // Android configuration (for future use)
  android: {
    // Emulator name
    emulator: 'Pixel_7_API_34',

    // App package name
    packageName: 'com.example.tasto',

    // Path to .apk file
    apkPath: './android/app/build/outputs/apk/debug/app-debug.apk',
  },

  // Optional setup function run before tests
  // setup: async () => {
  //   console.log('Setting up tests...');
  // },

  // Optional teardown function run after tests
  // teardown: async () => {
  //   console.log('Cleaning up...');
  // },
};
