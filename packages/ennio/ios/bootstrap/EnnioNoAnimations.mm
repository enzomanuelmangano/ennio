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
        // Drop the animation entirely. The layer's model value was already
        // set by the caller; without the animation it's displayed at once.
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
