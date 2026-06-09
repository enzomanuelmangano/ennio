//
// EnnioNoAnimations.mm — see header.
//

#import "EnnioNoAnimations.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL g_enabled = NO;

// Original implementation of -[CALayer addAnimation:forKey:], saved so the
// swizzled version can no-op while staying a valid method (some callers
// inspect the return). We simply DON'T call through — adding the animation
// is what plays it, so skipping the add snaps the property to its final
// model value with no interpolation.
static void (*g_origAddAnimation)(id, SEL, CAAnimation *, NSString *) = NULL;

static void ennio_addAnimation(id self, SEL _cmd, CAAnimation *anim, NSString *key) {
    if (g_enabled) {
        // Time-compress instead of dropping. Dropping the add silently
        // loses the animation's delegate callbacks — and UIKit's modal
        // present/dismiss state machine blocks on animationDidStop:
        // (observed: bsky's avatar pageSheet stuck open after "Done",
        // UIMenu intermittently failing to present). Playing the
        // animation at 1000x keeps every delegate/completion firing
        // through the normal machinery while finishing within ~a frame.
        if (anim.repeatCount == HUGE_VALF || anim.repeatDuration == INFINITY) {
            // Infinite loops (activity spinners) never complete by
            // design — no delegate to preserve. Drop them so the
            // animations_active settle signal doesn't see a perpetual
            // 1000x loop as in-flight animation.
            return;
        }
        anim.speed = 1000.0f;
        if (g_origAddAnimation) g_origAddAnimation(self, _cmd, anim, key);
        return;
    }
    if (g_origAddAnimation) g_origAddAnimation(self, _cmd, anim, key);
}

@implementation EnnioNoAnimations

+ (BOOL)isEnabled {
    return g_enabled;
}

+ (void)installIfEnabled {
    const char *v = getenv("ENNIO_NO_ANIMATIONS");
    BOOL want = v != NULL && v[0] != '\0' && strcmp(v, "0") != 0;
    if (want) [self setEnabled:YES];
}

+ (void)setEnabled:(BOOL)enabled {
    if (enabled) {
        // Swizzle -[CALayer addAnimation:forKey:] once. After this,
        // g_enabled gates the behaviour so it toggles without re-swizzling.
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            Class cls = [CALayer class];
            SEL sel = @selector(addAnimation:forKey:);
            Method m = class_getInstanceMethod(cls, sel);
            if (m) {
                g_origAddAnimation =
                    (void (*)(id, SEL, CAAnimation *, NSString *))method_getImplementation(m);
                method_setImplementation(m, (IMP)ennio_addAnimation);
            }
        });
    }
    if (g_enabled == enabled) return;
    g_enabled = enabled;
    // UIView block animations app-wide too — belt and braces for paths
    // that check +areAnimationsEnabled before building a CAAnimation.
    [UIView setAnimationsEnabled:!enabled];
    NSLog(@"[Ennio] animations %@", enabled ? @"SUPPRESSED — transitions snap to final frame"
                                            : @"RESTORED");
}

@end
