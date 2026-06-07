//
// EnnioNoAnimations.h
//
// Opt-in (ENNIO_NO_ANIMATIONS) global animation kill for E2E speed.
// Collapses every Core-Animation-driven transition (UIKit nav push/pop,
// modal present/dismiss, LayoutAnimation, UIView block animations,
// toasts) to its final frame instantly, so the runner's post-tap
// react-commit settle fires at ~16ms instead of waiting out a 300-500ms
// animation. The app's LOGIC is unchanged — only the visual interpolation
// is removed. Off by default (it can alter flows that assert mid-animation
// state); the CLI sets the env flag from `--no-animations`.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioNoAnimations : NSObject

/// Install the CALayer animation suppressor. Idempotent. No-op unless the
/// ENNIO_NO_ANIMATIONS env flag is set.
+ (void)installIfEnabled;

/// Whether the suppressor is currently active.
+ (BOOL)isEnabled;

@end

NS_ASSUME_NONNULL_END
