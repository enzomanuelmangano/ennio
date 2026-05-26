//
// EnnioTouchSynth.h
//
// Fast in-process tap dispatcher. Two strategies tried in order:
//
//   1. accessibilityActivate on the hit-tested view (5-10 ms, no
//      private API). RN Pressables, UIButton, UITextField — anything
//      with accessibilityTraits.button — handles this and fires its
//      onPress / target-action.
//   2. UIControl.sendActionsForControlEvents UIControlEventTouchUpInside
//      walking the hit view + ancestors. Catches plain UIControl
//      subclasses missed by step 1.
//
// Steps that need real UITouch delivery (drag, pinch, long-press
// gesture coordination) still go through idb. This is the fast-path
// for the common case (tapping a button), saving the 400 ms idb
// subprocess spawn.
//
// Sim only. No private API on this current iteration — the prior
// UITouch synth crashed on iOS 26's _addTouch validation, so we
// avoid that path entirely.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioTouchSynth : NSObject

/// Activate the topmost interactive view at window-space (x, y).
/// Returns YES if a handler fired. NO if no activatable target found
/// at the point — caller falls back to idb HID for a real touch.
+ (BOOL)activateAtX:(double)x y:(double)y;

@end

NS_ASSUME_NONNULL_END
