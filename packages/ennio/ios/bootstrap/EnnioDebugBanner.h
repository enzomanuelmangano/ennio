//
// EnnioDebugBanner.h
// Flutter-style top-right diagonal "E2E" ribbon, shown whenever Ennio
// is active in the running build. Touches pass through — the ribbon
// never intercepts user interaction or test-runner taps.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioDebugBanner : NSObject

/// Idempotent. Safe to call from any thread; attach happens on main.
+ (void)show;

/// Tear the banner down: hide and release its window so the ribbon
/// disappears from the running app. Idempotent and null-safe — a no-op
/// if the banner was never shown. Safe to call from any thread; the
/// UIKit teardown happens on main. Backs the `clear_overlays` op so a
/// crashed/aborted run's lingering ribbon can be wiped.
+ (void)hide;

@end

NS_ASSUME_NONNULL_END
