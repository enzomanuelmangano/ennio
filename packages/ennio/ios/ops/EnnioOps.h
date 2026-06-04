//
// EnnioOps.h
//
// UIKit-level operations driven from socket handlers. Each method does
// one thing, returns BOOL or a typed result. Pure UIKit. No XCTest.
//
// Scope (v0.1):
//   - Alerts: introspection, button tap, dismiss
//   - Tabs: UITabBarController select by name
//   - Navigation: back (UINavigationController popViewController)
//   - Keyboard: hide
//   - Scroll: scroll by testID, scrollTo (bring element into view)
//   - Clipboard: copy / paste
//   - Hardware key: route to firstResponder if conforms to UIKeyInput
//   - Swipe at points: UITouch loop for cross-view drag
//
// Deferred to v0.2: picker, search bar, segmented control,
// UIView animation observation, drag-to-rearrange.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioOps : NSObject

// ─── Alerts ─────────────────────────────────────────────────────────

+ (BOOL)isAlertPresent;
+ (NSString *)alertText;
+ (NSArray<NSString *> *)alertButtons;
+ (BOOL)tapAlertButton:(NSString *)buttonText;
+ (BOOL)dismissAlert;

// ─── Tabs ───────────────────────────────────────────────────────────

/// Find a UITabBarController in any window scene and select the tab
/// whose tabBarItem.title / vc.title / accessibilityIdentifier matches
/// `name` (case-insensitive). Fires the delegate so RN sees the change.
+ (BOOL)tapTabByName:(NSString *)name;

/// Existence query — same matching rules as +tapTabByName, no tap.
+ (BOOL)findTabByName:(NSString *)name;

/// True when the named tab is the CURRENTLY selected one. Re-tapping
/// the current tab has pop-to-root semantics that synthetic selection
/// can't reproduce faithfully — callers route that case to a real tap.
+ (BOOL)isTabSelectedByName:(NSString *)name;

// ─── Navigation ─────────────────────────────────────────────────────

+ (BOOL)backGesture;
+ (BOOL)hideKeyboard;

/// Block the caller until no view controller in the hierarchy is
/// mid-present or mid-dismiss (isBeingPresented / isBeingDismissed all
/// NO), or `maxMs` elapses. Returns the elapsed milliseconds. Used as
/// a pre-tap settle to avoid taps landing while a sheet's residual
/// overlay UIView still absorbs touches.
+ (uint32_t)waitForPresentationIdleWithTimeout:(uint32_t)maxMs;

// ─── Scrolling ──────────────────────────────────────────────────────

+ (BOOL)scrollTestID:(NSString *)testID
           direction:(NSString *)direction
            distance:(double)distance;

+ (BOOL)scrollViewWithTestID:(NSString *)scrollViewTestID
                  toTestID:(NSString *)elementTestID;

// ─── Clipboard ──────────────────────────────────────────────────────

+ (BOOL)clipboardCopy:(NSString *)text;
+ (BOOL)clipboardPasteIntoTestID:(NSString *)testID;
+ (NSString *)clipboardText;

// ─── Hardware key ───────────────────────────────────────────────────

+ (BOOL)pressHardwareKey:(int)keyCode;

/// Send a literal string to the firstResponder via UIKeyInput. Bypasses
/// the simulator's hardware-keyboard locale, so unicode characters and
/// special chars (@, è, accents) survive intact — a synthesized key
/// translated through the active keyboard layout and corrupts them.
+ (BOOL)insertText:(NSString *)text;

/// Make the view bearing `testID` the firstResponder. Bypasses the
/// HID taps that can't focus a 1×1 px hidden input (a common
/// e2e-only pattern in apps that need a side-channel to inject
/// metadata into the app — Bluesky's e2eProxyHeaderInput etc.).
+ (BOOL)focusByTestID:(NSString *)testID;

/// Programmatically activate the view bearing `testID` — equivalent
/// to a VoiceOver double-tap. For Pressables, fires the onPress
/// action via accessibilityActivate. Used as a fallback when HID
/// taps on 1×1 hit areas are too flaky (e.g. Bluesky's e2e-only
/// test controls all rendered at 1×1).
+ (BOOL)activateByTestID:(NSString *)testID;

/// Lower-level: invoke the same private touch-activate path on a
/// given UIView. Caller is expected to have already found / vetted
/// the view (e.g. by text). Returns NO if no activate-capable
/// gesture chain exists on the view.
+ (BOOL)activateView:(UIView *)view;

/// Find a descendant view in the subtree of `parentTestID` whose own
/// accessibilityIdentifier matches `childTestID`. Implements Maestro's
/// `childOf:` hierarchical selector — pick the postDropdownBtn that
/// lives inside feedItem-by-alice.test, not the first one in the
/// flat tree. Returns the matched view, or nil. Output rect is
/// reported via the same windowRectFor: path used by find_by_testid.
+ (nullable UIView *)findChildTestID:(NSString *)childTestID inParentTestID:(NSString *)parentTestID;

// ─── Swipe at points ────────────────────────────────────────────────

/// Synthesize a pan gesture from (x1,y1) to (x2,y2) over durationMs.
/// Fast path when the start point hits a UIScrollView ancestor: calls
/// setContentOffset directly. Otherwise drives a UITouch loop along
/// the line.
+ (BOOL)swipeFromX:(double)x1
                 y:(double)y1
              toX:(double)x2
                 y:(double)y2
        durationMs:(double)durationMs;


/// Trigger UIRefreshControl on the scroll view containing (x, y).
/// HID swipes don't reliably cross UIRefreshControl's pan-distance
/// threshold on iOS 26 simulators (touch events arrive in two endpoint
/// chunks without enough interpolated Moves). This synthesises the
/// refresh by calling `beginRefreshing` + sending `valueChanged`
/// actions directly on the UIRefreshControl. RN's RefreshControl
/// listens for that event.
+ (BOOL)triggerRefreshAtX:(double)x y:(double)y;

/// Returns YES if the scroll view containing (x, y) has a
/// UIRefreshControl currently in the refreshing state. The CLI uses
/// this to throttle YAML "warm-up + trigger" double-swipe patterns —
/// without it, two HID swipes both cross the pan threshold on
/// iOS 26 sim and fire onRefresh twice.
+ (BOOL)isRefreshingAtX:(double)x y:(double)y;

// ─── Sandbox ────────────────────────────────────────────────────────

/// Wipe Library/, Documents/, tmp/ in-process. Caller can restart the
/// app to drop in-memory state.
+ (BOOL)clearAppData;

@end

NS_ASSUME_NONNULL_END
