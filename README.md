# Tasto

> Fast React Native E2E testing via direct Fabric shadow tree access

Tasto provides blazing-fast E2E testing for React Native apps by directly accessing the Fabric shadow tree, bypassing the need for XCTest/Espresso bridges. Unlike traditional testing frameworks that use accessibility APIs or native test frameworks, Tasto communicates directly with React Native's rendering engine for maximum speed and reliability.

## Why Tasto?

| Feature | Tasto | Detox | Appium |
|---------|-------|-------|--------|
| Element lookup | O(1) hash-based | O(n) accessibility tree | O(n) accessibility tree |
| Setup complexity | Single npm package | Complex native deps | Complex server setup |
| Architecture | Direct Fabric access | XCTest/Espresso bridge | WebDriver protocol |
| New Architecture | Native support | Compatibility layer | Limited support |
| Speed | ~50ms per action | ~100-200ms per action | ~500ms+ per action |

## Features

- **Direct Shadow Tree Access** - Query and interact with elements at native speed
- **O(1) TestID Lookup** - Hash-based registry for instant element finding
- **Native Event Dispatch** - Tap, type, scroll through React Native's event system
- **Real Scroll Support** - Actually scrolls native UIScrollView/ScrollView
- **Alert/Modal Handling** - Detect and interact with native alerts
- **WebSocket Protocol** - Connect from Node.js for test orchestration
- **Fluent API** - Clean, chainable test syntax
- **No Native Test Framework** - Works without XCTest or Espresso dependencies

## Requirements

- React Native 0.76+ (New Architecture / Fabric required)
- iOS 15+ / Android API 24+
- Node.js 18+
- Bun or npm/yarn

## Installation

### 1. Install packages

```bash
# Using bun
bun add @tasto/nitro @tasto/app
bun add -D @tasto/runner

# Using yarn
yarn add @tasto/nitro @tasto/app
yarn add -D @tasto/runner

# Using npm
npm install @tasto/nitro @tasto/app
npm install -D @tasto/runner
```

### 2. iOS Setup

```bash
cd ios && pod install
```

### 3. Android Setup

No additional setup required - the native module auto-links.

### 4. Wrap your app with TastoProvider

```tsx
// App.tsx or your root component
import { TastoProvider } from '@tasto/app';

export default function App() {
  return (
    <TastoProvider port={9876}>
      <YourApp />
    </TastoProvider>
  );
}
```

The `TastoProvider`:
- Starts a WebSocket server on the specified port (default: 9876)
- Initializes the shadow tree access
- Only active in development builds

### 5. Add test script to package.json

```json
{
  "scripts": {
    "test:e2e": "tasto e2e/"
  }
}
```

## Quick Start

### 1. Add testIDs to your components

```tsx
<View testID="home-screen">
  <TextInput
    testID="search-input"
    placeholder="Search..."
  />
  <Pressable testID="search-btn" onPress={handleSearch}>
    <Text>Search</Text>
  </Pressable>
  <FlatList
    testID="results-list"
    data={results}
    renderItem={({ item }) => (
      <View testID={`result-${item.id}`}>
        <Text>{item.title}</Text>
      </View>
    )}
  />
</View>
```

### 2. Create a test file

```typescript
// e2e/search.test.ts
import {
  element,
  waitForVisible,
  waitForElement,
  sleep
} from '@tasto/runner';

export default async function searchTests(): Promise<void> {
  // Wait for screen to be visible
  await waitForVisible('home-screen');

  // Type in search input
  await element('search-input').typeText('React Native');

  // Tap search button
  await element('search-btn').tap();

  // Wait for results
  await waitForElement('result-1');

  // Verify results are visible
  await element('results-list').toBeVisible();
  await element('result-1').toBeVisible();
}
```

### 3. Run tests

```bash
# Start your app first
npx expo run:ios
# or
npx react-native run-ios

# In another terminal, run tests
bun run test:e2e
# or
npx tasto e2e/
```

## Writing Tests

### Test File Structure

Each test file should export a default async function:

```typescript
// e2e/my-feature.test.ts
import { element, waitForVisible, sleep } from '@tasto/runner';

export default async function myFeatureTests(): Promise<void> {
  // Your tests here
}
```

### Using runTest Helper

For better test organization and reporting, use a `runTest` helper:

```typescript
// e2e/setup.ts
export async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<void> {
  console.log(`▸ ${name}`);
  const start = Date.now();
  try {
    await testFn();
    console.log(`  ✓ Passed (${Date.now() - start}ms)`);
  } catch (error) {
    console.log(`  ✗ Failed: ${error.message}`);
    throw error;
  }
}

// e2e/login.test.ts
import { element, waitForVisible } from '@tasto/runner';
import { runTest } from './setup';

export default async function loginTests(): Promise<void> {
  await runTest('should display login form', async () => {
    await element('login-screen').toBeVisible();
    await element('email-input').toBeVisible();
    await element('password-input').toBeVisible();
  });

  await runTest('should login with valid credentials', async () => {
    await element('email-input').typeText('user@example.com');
    await element('password-input').typeText('password123');
    await element('submit-btn').tap();
    await waitForVisible('home-screen');
  });
}
```

## API Reference

### Element Selection

```typescript
import { element } from '@tasto/runner';

// Get element by testID
const el = element('my-button');
```

### Queries

```typescript
// Check if element exists in shadow tree
const exists: boolean = await element('id').exists();

// Check if element is visible on screen
const visible: boolean = await element('id').isVisible();

// Get element info (testID, type, text, layout)
const info: ElementInfo | null = await element('id').getInfo();

// Get layout metrics (x, y, width, height, screenX, screenY)
const layout: LayoutMetrics | null = await element('id').getLayout();

// Get text content
const text: string | null = await element('id').getText();
```

### Actions

```typescript
// Tap on element
await element('button').tap();

// Long press (default 500ms)
await element('button').longPress();
await element('button').longPress(1000); // 1 second

// Type text into TextInput
await element('input').typeText('Hello World');

// Clear text from TextInput
await element('input').clearText();

// Replace text in TextInput
await element('input').replaceText('New Text');

// Scroll by delta (pixels)
await element('scroll-view').scroll(0, 200);    // Scroll down 200px
await element('scroll-view').scroll(0, -200);   // Scroll up 200px
await element('scroll-view').scroll(100, 0);    // Scroll right 100px

// Scroll to make child element visible
await element('scroll-view').scrollTo('target-element');

// Scroll to index (for FlatList)
await element('flat-list').scrollToIndex(10);

// Swipe gesture
await element('view').swipe('up', 300);
await element('view').swipe('down', 300);
await element('view').swipe('left', 200);
await element('view').swipe('right', 200);
```

### Assertions

```typescript
// Assert element exists
await element('id').toExist();

// Assert element does not exist
await element('id').toNotExist();

// Assert element is visible
await element('id').toBeVisible();

// Assert element is not visible
await element('id').toNotBeVisible();

// Assert element has exact text
await element('id').toHaveText('Expected Text');

// Assert element contains text
await element('id').toContainText('partial');
```

### Waiting

```typescript
import {
  waitFor,
  waitForElement,
  waitForVisible,
  waitForNotExist,
  waitForNotVisible,
  sleep
} from '@tasto/runner';

// Wait for element to exist
await waitForElement('loading-indicator');

// Wait for element to be visible
await waitForVisible('content', { timeout: 10000 });

// Wait for element to not exist
await waitForNotExist('loading-indicator');

// Wait for element to not be visible
await waitForNotVisible('modal');

// Wait for custom condition
await waitFor(async () => {
  const text = await element('counter').getText();
  return text === '10';
}, { timeout: 5000 });

// Sleep (use sparingly)
await sleep(500);
```

### Alert/Modal Handling

```typescript
import { Alert, isAlertPresent, tapAlertButton, waitForAlert } from '@tasto/runner';

// Check if an alert is present
const hasAlert: boolean = await Alert.isPresent();

// Wait for alert to appear
await Alert.waitFor({ timeout: 5000 });

// Get alert text (title + message)
const text: string = await Alert.getText();

// Get alert button titles
const buttons: string[] = await Alert.getButtons();

// Tap alert button by text
await Alert.tap('OK');
await Alert.tap('Cancel');
await Alert.tap('Delete');

// Dismiss alert (taps cancel/OK)
await Alert.dismiss();
```

### Configuration

```typescript
import { configure } from '@tasto/runner';

// Configure test runner
configure({
  defaultTimeout: 10000,  // Default timeout for waitFor (ms)
  retryCount: 50,         // Number of retries for waitFor
  retryDelay: 100,        // Delay between retries (ms)
  verbose: true,          // Enable verbose logging
});
```

### Synchronization

```typescript
import { synchronize, waitForIdle } from '@tasto/runner';

// Wait for app to be idle (no pending animations/network)
await waitForIdle(5000);

// Force synchronization
await synchronize();
```

## Running Tests

### Basic Usage

```bash
# Run all tests in e2e/ directory
npx tasto e2e/

# Run specific test file
npx tasto e2e/login.test.ts

# Run with custom port
npx tasto e2e/ --port 9999

# Run with verbose output
npx tasto e2e/ --verbose
```

### With bun

```bash
bun run tasto e2e/
```

### Test Output

```
Tasto Test Runner
Connecting to localhost:9876...
Connected!

Found 6 test file(s)

▸ e2e/auth.test.ts

▸ should display login form
  ✓ Passed (52ms)

▸ should login with valid credentials
  ✓ Passed (312ms)
  ✓ Passed

▸ e2e/home.test.ts
...

──────────────────────────────────────────────────
Results:
  ✓ 6 passed (15234ms)
```

## Configuration File

Create `tasto.config.js` in your project root:

```javascript
module.exports = {
  // Connection settings
  host: 'localhost',
  port: 9876,
  timeout: 30000,

  // iOS settings
  ios: {
    simulator: 'iPhone 15 Pro',
    bundleId: 'com.example.app',
    appPath: './ios/build/Build/Products/Debug-iphonesimulator/App.app',
  },

  // Android settings (future)
  android: {
    emulator: 'Pixel_7_API_34',
    packageName: 'com.example.app',
    appPath: './android/app/build/outputs/apk/debug/app-debug.apk',
  },

  // Test settings
  testMatch: ['e2e/**/*.test.ts'],
  setupFiles: ['e2e/setup.ts'],
};
```

## Debugging

### Enable Verbose Logging

```typescript
configure({ verbose: true });
```

### Check Native Logs

```bash
# iOS - view Tasto logs
xcrun simctl spawn booted log stream --predicate 'process == "YourApp" AND message CONTAINS "[Tasto]"'
```

### Common Issues

**Element not found**
- Verify the `testID` prop is set correctly
- Check if the element is rendered (conditional rendering)
- Wait for the element to appear: `await waitForElement('testID')`

**Tap not working**
- Ensure the element is visible and not covered by another view
- Check if the element has `pointerEvents="none"`
- Verify the Pressable/TouchableOpacity has an `onPress` handler

**Text input not working**
- Ensure the TextInput is focused first (tap it)
- Check if the keyboard is blocking other elements

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Test Runner (Node.js)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Test Files  │  │ Fluent API  │  │ WebSocket Client        │  │
│  │ (*.test.ts) │  │ (element()) │  │ (JSON Protocol)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                    WebSocket Connection
                         (port 9876)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    React Native App                             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    TastoProvider                            ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐ ││
│  │  │ WebSocket     │  │ HybridTasto   │  │ Event           │ ││
│  │  │ Server (C++)  │  │ (Nitro)       │  │ Dispatcher      │ ││
│  │  └───────────────┘  └───────────────┘  └─────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Fabric Shadow Tree                        ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ ││
│  │  │ TestID      │  │ Shadow Tree │  │ Layout              │ ││
│  │  │ Registry    │  │ Traverser   │  │ Metrics             │ ││
│  │  │ (O(1) lookup│  │             │  │                     │ ││
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Native Views (iOS/Android)                     ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ ││
│  │  │ UIKit       │  │ UIScrollView│  │ UIAlertController   │ ││
│  │  │ Touch Events│  │ Scrolling   │  │ Alert Handling      │ ││
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

1. **Test Runner** (`@tasto/runner`)
   - Node.js CLI tool
   - Fluent API for writing tests
   - WebSocket client for communication

2. **TastoProvider** (`@tasto/app`)
   - React component that initializes Tasto
   - Starts WebSocket server
   - Development-only (no production overhead)

3. **HybridTasto** (`@tasto/nitro`)
   - C++ Nitro module
   - Direct access to Fabric shadow tree
   - Native event dispatch

4. **TestID Registry**
   - O(1) hash-based element lookup
   - Updated on shadow tree commits

5. **Event Dispatcher**
   - Dispatches touch, scroll, text events
   - Uses React Native's event system

## WebSocket Protocol

### Request Format

```json
{
  "id": "unique-request-id",
  "type": "command-name",
  "payload": { /* command-specific data */ }
}
```

### Response Format

```json
{
  "id": "unique-request-id",
  "success": true,
  "data": { /* response data */ }
}

{
  "id": "unique-request-id",
  "success": false,
  "error": "Error message"
}
```

### Available Commands

| Command | Payload | Description |
|---------|---------|-------------|
| `exists` | `{ testID }` | Check if element exists |
| `isVisible` | `{ testID }` | Check if element is visible |
| `findByTestID` | `{ testID }` | Get element info |
| `getLayoutMetrics` | `{ testID }` | Get layout metrics |
| `getText` | `{ testID }` | Get text content |
| `tap` | `{ testID }` | Tap on element |
| `longPress` | `{ testID, durationMs }` | Long press |
| `typeText` | `{ testID, text }` | Type text |
| `clearText` | `{ testID }` | Clear text |
| `replaceText` | `{ testID, text }` | Replace text |
| `scroll` | `{ testID, deltaX, deltaY }` | Scroll by delta |
| `scrollTo` | `{ scrollViewTestID, elementTestID }` | Scroll to element |
| `scrollToIndex` | `{ testID, index }` | Scroll to index |
| `swipe` | `{ testID, direction, distance }` | Swipe gesture |
| `isAlertPresent` | `{}` | Check for alert |
| `getAlertText` | `{}` | Get alert text |
| `getAlertButtons` | `{}` | Get alert buttons |
| `tapAlertButton` | `{ buttonText }` | Tap alert button |
| `dismissAlert` | `{}` | Dismiss alert |
| `waitForIdle` | `{ timeout }` | Wait for idle |
| `synchronize` | `{}` | Force sync |

## Platform Support

| Feature | iOS | Android |
|---------|-----|---------|
| Element queries | ✅ | ✅ |
| Tap | ✅ | ✅ |
| Long press | ✅ | ✅ |
| Type text | ✅ | ✅ |
| Clear text | ✅ | ✅ |
| Scroll | ✅ (native) | ⚠️ (event only) |
| Swipe | ✅ | ✅ |
| Alert handling | ✅ | ❌ (planned) |

## Best Practices

### 1. Use Descriptive testIDs

```tsx
// Good
<Button testID="login-submit-btn" />
<TextInput testID="login-email-input" />

// Bad
<Button testID="btn1" />
<TextInput testID="input" />
```

### 2. Wait for Elements

```typescript
// Good - wait for element before interacting
await waitForVisible('home-screen');
await element('search-btn').tap();

// Bad - may fail if element isn't ready
await element('search-btn').tap();
```

### 3. Use Conditional Logic for Optional Elements

```typescript
const hasModal = await element('modal').exists();
if (hasModal) {
  await element('modal-close-btn').tap();
}
```

### 4. Avoid Hardcoded Sleeps

```typescript
// Good - wait for specific condition
await waitForVisible('results-list');

// Bad - arbitrary delay
await sleep(2000);
```

### 5. Clean Up Test State

```typescript
export default async function tests() {
  // Setup
  await goToHomeScreen();

  try {
    // Tests
    await runTest('test 1', async () => { ... });
    await runTest('test 2', async () => { ... });
  } finally {
    // Cleanup
    await logout();
  }
}
```

## Troubleshooting

### "Connection refused" error

- Ensure the app is running with TastoProvider
- Check if the port (default 9876) is available
- Verify the app is running on the same machine/network

### Tests are flaky

- Add appropriate waits before interactions
- Check for race conditions in your app
- Use `waitForIdle()` after navigation

### Element not found but exists in UI

- Verify testID is set on the correct component
- Check if element is conditionally rendered
- Ensure the testID prop is passed to a native view

### Scroll not working

- Verify the testID is on the ScrollView/FlatList
- Check if contentSize is larger than viewport
- Try using swipe instead of scroll

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun run test:e2e`
5. Submit a pull request

## License

MIT

---

Built with ❤️ for the React Native community
