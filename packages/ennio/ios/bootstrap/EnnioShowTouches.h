//
// EnnioShowTouches.h
//
// Opt-in (ENNIO_SHOW_TOUCHES) visual touch indicator — the iOS analogue
// of Android's "show touches" developer setting. Every touch the app
// receives (ennio's HID-synthesized ones included — they arrive as real
// UITouches) is drawn as a ripple on a passthrough overlay window:
// a circle that follows the finger, breadcrumb dots along swipe paths,
// and a fade-out on lift.
//
// Designed to be invisible to ennio's own instrumentation:
//   * The overlay is a separate, never-key UIWindow — wait_commit's
//     frame hash walks only the key window, so ripples never perturb
//     settle.
//   * Indicators animate via a CADisplayLink lerp, NOT CAAnimations —
//     they survive ENNIO_NO_ANIMATIONS' 1000x time-compression and are
//     invisible to the animations_active transition probe (which only
//     inspects view-controller transitionCoordinators).
//   * hitTest always returns nil and no indicator carries accessibility
//     identity, so finders, dump_views consumers, and real taps pass
//     straight through.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioShowTouches : NSObject

/// Install the UIApplication sendEvent: hook if ENNIO_SHOW_TOUCHES is
/// set (any value but "0"). Call once UIKit is up.
+ (void)installIfEnabled;

/// Runtime toggle (set_show_touches socket op). Enabling installs the
/// hook on first use; disabling clears every live indicator immediately
/// so the overlay leaves no trace once a run ends.
+ (void)setEnabled:(BOOL)enabled;

@end

NS_ASSUME_NONNULL_END
