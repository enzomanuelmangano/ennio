# Tasto E2E Testing Framework - Implementation Status

## Overview

Tasto is an E2E testing framework for React Native Fabric apps that leverages direct shadow tree access for O(1) element lookups.

## Completed Implementation

### Phase 1: Core C++ Integration (CRITICAL) ✅

#### 1.1 Shadow Tree Root Access
- **Files:** `HybridTasto.hpp`, `HybridTasto.cpp`
- Added `initialize()` method accepting UIManager weak_ptr and SurfaceId
- Implemented `getShadowTreeRoot()` using UIManager's ShadowTreeRegistry
- Added `findNode()` helper that tries O(1 registry lookup then tree traversal

#### 1.2 TestIDRegistry Bug Fix ✅
- **File:** `TestIDRegistry.cpp:97`
- Fixed `traverseAndRegister()` to accept `ShadowNodePtr` instead of const reference
- Now properly stores weak_ptr from shared_ptr for O(1 lookups

#### 1.3 Wire HybridTasto to Components ✅
- **File:** `HybridTasto.cpp`
- Connected all stub methods to real implementations:
  - `findByTestID()` - O(1 registry + tree traversal fallback
  - `exists()` - Uses findNode()
  - `isVisible()` - Uses ShadowTreeTraverser with screen bounds
  - `getText()` - Uses ShadowTreeTraverser
  - `getLayoutMetrics()` - Uses ShadowTreeTraverser with path accumulation
- Implemented full WebSocket command handler

#### 1.4 EventDispatcher Implementation ✅
- **File:** `EventDispatcher.cpp`
- Implemented `dispatchTouchEvent()` with proper Touch structures
- Added TouchEventEmitter integration for touch events
- Added TextInputEventEmitter integration for typeText/focus/blur
- Added ScrollViewEventEmitter integration for scroll events

### Phase 2: App Launching ✅

#### 2.1 iOS Simulator Launch
- **File:** `packages/runner/src/launcher.ts`
- Implemented `launchIOS()` with full simulator lifecycle:
  - `findSimulator()` - Find by name or UDID
  - `bootSimulator()` - xcrun simctl boot
  - `installAppIOS()` - xcrun simctl install
  - `launchAppIOS()` - xcrun simctl launch
  - `waitForTastoServer()` - WebSocket connection check

#### 2.2 Config File Support ✅
- **File:** `packages/runner/src/config.ts`
- Created `TastoConfig` interface with iOS/Android options
- Support for `tasto.config.js`, `.mjs`, `.cjs`, `.ts`
- Support for config in `package.json` under `tasto` key

### Phase 3: Synchronization ✅

#### 3.1 Real Idle Detection
- **File:** `packages/nitro/cpp/IdleMonitor.hpp`
- Implemented singleton IdleMonitor tracking:
  - Pending shadow tree commits/mounts
  - Pending JS tasks
  - Pending network requests (optional)
  - Pending animations (optional)
- Added `waitForIdle()` with stability requirement
- Atomic counters for thread safety

### Phase 4: Developer Experience ✅

#### 4.1 Debug Logging
- **File:** `packages/nitro/cpp/TastoLog.hpp`
- TASTO_DEBUG preprocessor flag control
- Log levels: Error, Warn, Info, Debug, Trace
- Timestamp formatting
- Macros for zero-overhead disabled logging

#### 4.2 CLI Enhancements
- **File:** `packages/runner/src/bin/tasto.ts`
- Added `launch` command for simulator launching
- Added `list-devices` command
- Config file integration
- Better error messages

## Files Created/Modified

### New Files
```
packages/nitro/cpp/
├── IdleMonitor.hpp     # Idle detection for synchronization
└── TastoLog.hpp        # Debug logging infrastructure

packages/runner/src/
├── launcher.ts         # iOS/Android app launching
└── config.ts           # Config file loading

example/
└── tasto.config.js     # Example configuration
```

### Modified Files
```
packages/nitro/cpp/
├── HybridTasto.hpp     # Added UIManager, SurfaceId, helper methods
├── HybridTasto.cpp     # Full implementation wiring
├── TestIDRegistry.hpp  # Fixed method signature
├── TestIDRegistry.cpp  # Fixed bug at line 97
├── EventDispatcher.hpp # Added includes
└── EventDispatcher.cpp # Implemented touch/text/scroll events

packages/runner/src/
├── bin/tasto.ts        # Added launch command
└── index.ts            # Export new modules
```

## Remaining Work for Production

### iOS Native Integration
The C++ implementation is complete, but needs native iOS code to:
1. Hook into React Native's initialization to get UIManager reference
2. Call `HybridTasto::initialize()` with UIManager and SurfaceId
3. Hook IdleMonitor into UIManager's commit/mount callbacks

This would typically be done in `TastoNitro.mm` or via a custom AppDelegate hook.

### Android Support (Future Phase)
- Android-specific simctrl equivalent commands
- ADB integration for emulator control
- Android build configuration

## Usage

### Configuration
```javascript
// tasto.config.js
module.exports = {
  port: 9876,
  ios: {
    simulator: 'iPhone 16',
    bundleId: 'com.myapp',
    appPath: './ios/build/.../MyApp.app'
  }
};
```

### CLI Commands
```bash
# Run tests
tasto e2e/

# Launch iOS simulator and app
tasto launch --ios --simulator "iPhone 15" --bundle-id com.myapp

# List available devices
tasto list-devices
```

### Writing Tests
```typescript
import { element, waitForElement } from '@tasto/runner';

export default async function myTests() {
  await element('login-button').tap();
  await waitForElement('home-screen');
  await element('welcome-text').toHaveText('Welcome!');
}
```

## Architecture

```
┌─────────────────────────────────────────────┐
│ Test Runner (@tasto/runner)                  │
│ Node.js · WebSocket Client · Fluent API      │
└────────────────┬────────────────────────────┘
                 │ WebSocket (port 9876)
┌────────────────▼────────────────────────────┐
│ Native Module (@tasto/nitro)                 │
│ ┌──────────────────────────────────────────┐│
│ │ HybridTasto                              ││
│ │  ├─ WebSocketServer (command handling)   ││
│ │  ├─ TestIDRegistry (O(1) lookup)         ││
│ │  ├─ ShadowTreeTraverser (queries)        ││
│ │  ├─ EventDispatcher (actions)            ││
│ │  └─ IdleMonitor (synchronization)        ││
│ └──────────────────────────────────────────┘│
│                     │                        │
│         UIManager + ShadowTreeRegistry       │
└─────────────────────────────────────────────┘
```
