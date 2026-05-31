//
// EnnioFinder.h
//
// A11y-based discovery and UIKit ops. Pure ObjC, no React Native deps.
//
// Discovery model:
//
//   1. Cache: testID → UIView*  (weak refs). Hit when the view is still
//      attached to a window and its accessibilityIdentifier still
//      matches.
//   2. Walk: recursive UIView traversal from the key window, returning
//      the first view whose accessibilityIdentifier matches (or, for
//      `findByText`, whose accessibilityLabel / accessibilityValue
//      matches).
//
// UIKit ops (tabs, alerts, scroll, back, hideKeyboard, clipboard,
// hardware-key, swipe-at-points) operate directly on UIView /
// UIViewController APIs. No XCTest, no accessibility daemon.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Window-relative rect representation passed across the socket.
typedef struct {
    double x;
    double y;
    double w;
    double h;
} EnnioRect;

@interface EnnioFinder : NSObject

/// Resolve a testID to a UIView. Uses cache first, then a11y walk from
/// the key window. nil if not found / not on-screen.
+ (nullable UIView *)findViewByTestID:(NSString *)testID;

/// Resolve text (matches accessibilityLabel or accessibilityValue) to
/// a UIView. Uses a11y walk, no cache.
+ (nullable UIView *)findViewByText:(NSString *)text;

/// Relaxed variant: skips the topmost-VC filter so views behind
/// overlays (drawer, sheet) are also found. Use for visibility checks
/// where any on-screen match counts, not for tap targeting.
+ (nullable UIView *)findViewByText:(NSString *)text relaxed:(BOOL)relaxed;

/// Resolve text against the UIAccessibility element tree. Walks
/// accessibilityElements / accessibilityElementAtIndex: in addition
/// to subviews, so cross-process UIRemoteView contents (PHPicker,
/// share sheet, document picker) become reachable through their
/// UIAccessibilityElement proxies. Returns an opaque match rect in
/// window-space coords; the caller taps the rect's center.
+ (EnnioRect)findAxRectByText:(NSString *)text found:(BOOL *)found;

/// Convert a UIView's bounds to window coordinates. Returns CGRectZero
/// if the view is not attached to a window.
+ (EnnioRect)windowRectFor:(UIView *)view;

/// YES if the view's window-relative frame overlaps the key window's
/// visible bounds (i.e. a real finger could reach it).
+ (BOOL)isOnScreen:(UIView *)view;

/// Invalidate the entire testID → UIView cache. Called from clear_state
/// and whenever the cache is suspected stale.
+ (void)invalidateCache;

@end

NS_ASSUME_NONNULL_END
