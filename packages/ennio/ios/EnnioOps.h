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

// ─── Navigation ─────────────────────────────────────────────────────

+ (BOOL)backGesture;
+ (BOOL)hideKeyboard;

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

// ─── Sandbox ────────────────────────────────────────────────────────

/// Wipe Library/, Documents/, tmp/ in-process. Caller can restart the
/// app to drop in-memory state.
+ (BOOL)clearAppData;

@end

NS_ASSUME_NONNULL_END
