//
// EnnioTouchSynth.mm — see header.
//

#import "EnnioTouchSynth.h"
#import "../EnnioBootstrap.h"

#import <objc/runtime.h>

static UIView *_Nullable findActivatableUpwards(UIView *v) {
    for (UIView *cur = v; cur; cur = cur.superview) {
        if (cur.userInteractionEnabled) {
            UIAccessibilityTraits t = cur.accessibilityTraits;
            if ((t & UIAccessibilityTraitButton) || (t & UIAccessibilityTraitLink)) {
                return cur;
            }
            if ([cur isKindOfClass:UIControl.class]) return cur;
            // RNGH wraps every Pressable in a class that ends in
            // "GestureHandlerButton" — accept it as activatable.
            NSString *cls = NSStringFromClass([cur class]);
            if ([cls hasSuffix:@"GestureHandlerButton"]) return cur;
        }
    }
    return nil;
}

static BOOL fireUIControlAction(UIView *v, CGPoint inWindow) {
    if (![v isKindOfClass:UIControl.class]) return NO;
    UIControl *ctl = (UIControl *)v;
    // sendActionsForControlEvents:UIControlEventTouchUpInside is
    // exactly what UIKit invokes after a real touch-up over the
    // control. No private API.
    [ctl sendActionsForControlEvents:UIControlEventTouchUpInside];
    return YES;
    (void)inWindow;
}

@implementation EnnioTouchSynth

+ (BOOL)activateAtX:(double)x y:(double)y {
    __block BOOL fired = NO;
    void (^doActivate)(void) = ^{
        UIWindow *win = [EnnioBootstrap keyWindow];
        if (!win) return;
        CGPoint p = CGPointMake(x, y);
        UIView *hit = [win hitTest:p withEvent:nil];
        if (!hit) hit = win;

        UIView *target = findActivatableUpwards(hit);
        if (!target) target = hit;

        // Strategy 1: accessibilityActivate. RN Pressable, UIButton,
        // UITextField, etc. all wire this to their press handler.
        if ([target respondsToSelector:@selector(accessibilityActivate)]) {
            if ([target accessibilityActivate]) {
                fired = YES;
                return;
            }
        }
        // Strategy 2: UIControl action dispatch.
        if (fireUIControlAction(target, p)) {
            fired = YES;
            return;
        }
        // Strategy 3: invoke a UITapGestureRecognizer on the view
        // chain via its private _handleAction selector. Catches
        // RNGH BaseButton wrappers when (1) and (2) miss.
        for (UIView *cur = target; cur; cur = cur.superview) {
            for (UIGestureRecognizer *g in cur.gestureRecognizers) {
                if (!g.isEnabled) continue;
                if (![g isKindOfClass:UITapGestureRecognizer.class]) continue;
                SEL fire = NSSelectorFromString(@"_handleAction");
                if ([g respondsToSelector:fire]) {
                    IMP imp = [g methodForSelector:fire];
                    ((void (*)(id, SEL))imp)(g, fire);
                    fired = YES;
                    return;
                }
            }
        }
    };
    if (NSThread.isMainThread) doActivate();
    else dispatch_sync(dispatch_get_main_queue(), doActivate);
    return fired;
}

@end
