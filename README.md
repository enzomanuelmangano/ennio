# Tasto

> Fast React Native E2E testing via direct Fabric shadow tree access

Tasto provides blazing-fast E2E testing for React Native apps by directly accessing the Fabric shadow tree, bypassing the need for XCTest/Espresso bridges.

## Features

- **Direct Shadow Tree Access** - Query and interact with elements at native speed
- **O(1) TestID Lookup** - Hash-based registry for instant element finding
- **Native Event Firing** - Tap, type, scroll directly through Fabric EventEmitters
- **WebSocket Protocol** - Connect from Node.js for test orchestration
- **Fluent API** - Clean, chainable test syntax

## Packages

| Package | Description |
|---------|-------------|
| `@tasto/nitro` | C++ Nitro module with shadow tree access |
| `@tasto/runner` | Node.js test runner with fluent API |
| `@tasto/app` | React Native wrapper (TastoProvider) |

## Quick Start

### 1. Install packages

```bash
yarn add @tasto/nitro @tasto/app
yarn add -D @tasto/runner
```

### 2. Wrap your app

```tsx
import { TastoProvider } from '@tasto/app';

export default function App() {
  return (
    <TastoProvider>
      <YourApp />
    </TastoProvider>
  );
}
```

### 3. Add testIDs to your components

```tsx
<TouchableOpacity testID="submit-btn" onPress={handleSubmit}>
  <Text>Submit</Text>
</TouchableOpacity>
```

### 4. Write tests

```typescript
// e2e/login.test.ts
import { element, waitForVisible } from '@tasto/runner';

export default async function loginTests() {
  // Navigate
  await element('login-btn').tap();
  await waitForVisible('login-screen');

  // Fill form
  await element('email-input').typeText('user@example.com');
  await element('password-input').typeText('password123');

  // Submit
  await element('submit-btn').tap();

  // Assert
  await element('welcome-message').toBeVisible();
  await element('welcome-message').toContainText('Welcome');
}
```

### 5. Run tests

```bash
# Start your React Native app first, then:
npx tasto e2e/
```

## API Reference

### Element Queries

```typescript
element('testID')           // Get element wrapper
await element('id').toExist()       // Assert existence
await element('id').toBeVisible()   // Assert visibility
await element('id').toHaveText('x') // Assert text content
```

### Actions

```typescript
await element('btn').tap()
await element('btn').longPress(500)
await element('input').typeText('hello')
await element('input').clearText()
await element('scroll').scroll(0, 200)
await element('list').scrollToIndex(50)
await element('view').swipe('up', 300)
```

### Waiting

```typescript
await waitForElement('testID')
await waitForVisible('testID')
await waitForNotExist('testID')
await waitFor(() => element('id').toBeVisible())
```

## Architecture

```
┌─────────────────┐     WebSocket     ┌─────────────────┐
│   Test Runner   │◄──────────────────►│   React Native  │
│   (Node.js)     │    JSON Protocol   │   (C++ Module)  │
└─────────────────┘                    └─────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────────┐
                                    │   Fabric Shadow     │
                                    │   Tree              │
                                    └─────────────────────┘
```

## Development

```bash
# Install dependencies
yarn install

# Build all packages
yarn build

# Run example app
cd example && yarn ios
```

## WebSocket Protocol

Commands use JSON format:

```json
// Request
{ "id": "uuid", "type": "tap", "payload": { "testID": "submit-btn" } }

// Response
{ "id": "uuid", "success": true }
{ "id": "uuid", "success": false, "error": "Element not found" }
```

Supported commands:
- `findByTestID`, `exists`, `isVisible`, `getLayoutMetrics`
- `tap`, `longPress`, `typeText`, `clearText`, `replaceText`
- `scroll`, `scrollTo`, `scrollToIndex`, `swipe`
- `waitForIdle`, `synchronize`

## License

MIT
