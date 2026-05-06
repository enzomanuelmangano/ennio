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

@end

NS_ASSUME_NONNULL_END
