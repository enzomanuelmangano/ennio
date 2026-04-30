# Modal Tap Issue - Investigation Summary

## Problem Statement
Tapping elements inside React Native Modal components does not work correctly. When trying to tap buttons inside a Modal, either:
1. The tap hits the wrong element (modal overlay instead of button)
2. The modal closes with "Cancelled" instead of the intended action
3. The tap doesn't register at all

## Root Cause Analysis

### Issue 1: Shadow Tree Coordinate Mismatch
The shadow tree coordinates calculated for modal elements do not match native view positions.

**Evidence from logs:**
- Button's shadow tree `screenY`: 527.333
- Button center tap coordinate: (256.8, 549.0)
- Native modal dialog frame: (30.0, 341.3, 342.0, 191.3)
- Native modal dialog ends at Y: 532.6

**Problem:** The tap coordinate Y=549.0 is BELOW the modal dialog's bottom edge (532.6). The shadow tree calculates positions as if the modal is at a different Y position than its actual native view frame.

### Issue 2: Gesture Recognizer Conflict
Even when we find the correct RCT view to tap, the overlay's gesture recognizer intercepts the touch.

**View hierarchy for modal:**
```
UIView (gestureRecognizers: 1)  <- Modal overlay container
└── RCTViewComponentView        <- Modal content (overlay background)
    └── RCTViewComponentView    <- Modal dialog box
        └── ... buttons
```

The UIView at the top has a gesture recognizer that handles the overlay's `onPress`. When we send a synthetic touch, this gesture recognizer catches it before it reaches the button.

## What Was Tried

### Attempt 1: Find deepest RCT view
Search for the deepest RCT view at the tap point.
- **Result:** Found RCTViewComponentView but it was the modal content, not the button.
- **Problem:** Native `hitTest:withEvent:` returns the modal content view, not deeper button views.

### Attempt 2: Check direct children
Instead of deep search, check direct children of hit view for RCT views.
- **Result:** Found the modal content (RCTViewComponentView) correctly.
- **Problem:** The tap still triggered "Cancelled" because the overlay's gesture recognizer intercepted it.

### Attempt 3: Find view by accessibilityIdentifier
Implemented `performTapByTestID()` to find native views by their `accessibilityIdentifier` (which React Native sets to `testID`).
- **Result:** View found but tap at native coordinates still has issues.
- **Problem:** Still investigating - the native view's center point calculation might have issues or gesture recognizer still interfering.

## Technical Details

### Files Modified
1. **`packages/nitro/ios/TastoRuntimeHelper.mm`**
   - Added `findViewByAccessibilityIdentifier()` helper
   - Added `performTapByTestID()` method
   - Modified `performTap()` to search for RCT views in modal containers

2. **`packages/nitro/ios/TastoRuntimeHelper.h`**
   - Added `performTapByTestID()` declaration

3. **`packages/nitro/cpp/HybridTasto.cpp`**
   - Modified `tap()` to try `performTapByTestID()` first

### Key Observations

1. **Native view coordinates are correct:**
   ```
   Modal content subviews:
   - RCTViewComponentView frame(0.0,0.0,402.0x874.0) inside:1
     - RCTViewComponentView frame(30.0,341.3,342.0x191.3) inside:0
   ```
   The modal dialog is at (30, 341.3) with size (342, 191.3).

2. **Shadow tree coordinates are wrong:**
   ```
   Confirm button layout: {
     "screenX": 202.333,
     "screenY": 527.333
   }
   ```
   This places the button's top at Y=527.333, but the modal dialog ends at Y=532.6.

3. **Coordinate accumulation issue:**
   The `calculateAccumulatedOffset()` function adds up frame origins of all ancestors. For Modal elements, this calculation doesn't account for the modal's actual native positioning.

## Potential Solutions

### Solution 1: Fix coordinate calculation for Modals
Detect when an element is inside a Modal and adjust the coordinate calculation to use native view positions instead of shadow tree positions.

### Solution 2: Use native view lookup exclusively for tap
Always find the target view by accessibilityIdentifier and tap at its native center, bypassing shadow tree coordinates entirely.

### Solution 3: Disable gesture recognizers during tap
Before sending synthetic touch, find and disable the overlay's gesture recognizer, then re-enable after.

### Solution 4: Send event directly to view's responder
Instead of using UIApplication's sendEvent, directly call touchesBegan/touchesEnded on the target view or its gesture recognizers.

## Current State

### Latest Finding
The `performTapByTestID()` approach is not working because `accessibilityIdentifier` is not set on native views:
```
[Tasto] performTapByTestID: View with testID 'nav-modal-btn' not found
```

**Key insight:** In React Native Fabric (new architecture), the `testID` prop might not be automatically set as the native view's `accessibilityIdentifier`. The old architecture did this automatically, but Fabric may handle it differently or only set it when accessibility is explicitly enabled.

### Why accessibilityIdentifier may not be set
1. **Fabric behavior:** The new architecture may not automatically propagate testID to native views
2. **Accessibility not enabled:** Without `accessible={true}`, the view may not get accessibilityIdentifier
3. **View type:** Some component views may not support accessibilityIdentifier

## Next Steps
1. **Investigate Fabric testID handling:** Check if Fabric sets accessibilityIdentifier or uses a different mechanism
2. **Check if accessible={true} is needed:** Try adding `accessible={true}` to buttons
3. **Alternative approach:** Find views by walking the shadow tree to native view mapping
4. **Fix shadow tree coordinates:** Instead of finding views by testID, fix the coordinate calculation for modal elements
5. **Use gesture recognizer approach:** Directly trigger the button's gesture recognizer instead of synthetic touch

## Recommended Solution
The most robust fix would be to correct the shadow tree coordinate calculation for modal elements. The issue is that `calculateAccumulatedOffset()` doesn't account for how React Native Modal positions its content in a separate native view hierarchy with different coordinate origins.

Specifically:
- Modal content in shadow tree has coordinates relative to the modal's root
- But native modal views are positioned at (30, 341.3) within the window
- The shadow tree calculation doesn't know about this native positioning offset
