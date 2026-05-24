//
// EnnioTouchSynth.mm — see header.
//

#import "EnnioTouchSynth.h"
#import "EnnioBootstrap.h"

#import <objc/runtime.h>

static UIView *_Nullable findActivatableUpwards(UIView *v) {
    for (UIView *cur = v; cur; cur = cur.superview) {
        if (!cur.userInteractionEnabled) continue;
        UIAccessibilityTraits t = cur.accessibilityTraits;
        if ((t & UIAccessibilityTraitButton) || (t & UIAccessibilityTraitLink)) return cur;
        if ([cur isKindOfClass:UIControl.class]) return cur;
        // RNGH wraps every Pressable in a class that ends in
        // "GestureHandlerButton" — accept it as activatable.
        NSString *cls = NSStringFromClass([cur class]);
        if ([cls hasSuffix:@"GestureHandlerButton"]) return cur;
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

        // Strategy 0a: drive a UITapGestureRecognizer through its
        // state transitions (Began → Ended). Catches RNGH /
        // GestureHandlerButton and TouchableNativeFeedback wrappers
        // — anywhere a tap recogniser is attached.
        {
            SEL setStateSel = NSSelectorFromString(@"_setState:");
            for (UIView *cur = hit; cur; cur = cur.superview) {
                for (UIGestureRecognizer *g in cur.gestureRecognizers) {
                    if (!g.isEnabled) continue;
                    if (![g isKindOfClass:UITapGestureRecognizer.class]) continue;
                    if (![g respondsToSelector:setStateSel]) continue;
                    IMP imp = [g methodForSelector:setStateSel];
                    typedef void (*SetStateFn)(id, SEL, NSInteger);
                    ((SetStateFn)imp)(g, setStateSel, UIGestureRecognizerStateBegan);
                    ((SetStateFn)imp)(g, setStateSel, UIGestureRecognizerStateEnded);
                    fired = YES;
                    return;
                }
            }
        }
        // Strategy 0b: in-process UITouch synthesis. RN's Pressable
        // (bridgeless mode) doesn't use a tap recogniser — it
        // implements `touchesBegan:withEvent:` / `touchesEnded:`
        // directly on RCTView. Construct a UITouch via KVC + private
        // setters and dispatch the pair to the hit view. Returns YES
        // unconditionally because there's no inspectable post-state
        // — caller verifies via the next find_by_testid.
        {
            UITouch *t = [UITouch new];
            BOOL setOK = YES;
            @try {
                [t setValue:hit forKey:@"view"];
                [t setValue:hit.window forKey:@"window"];
                [t setValue:[NSValue valueWithCGPoint:p] forKey:@"locationInWindow"];
                [t setValue:[NSValue valueWithCGPoint:p] forKey:@"previousLocationInWindow"];
                [t setValue:@(CACurrentMediaTime()) forKey:@"timestamp"];
                [t setValue:@(1) forKey:@"tapCount"];
                [t setValue:@(1) forKey:@"isTap"];
            } @catch (NSException *e) {
                setOK = NO;
            }
            if (setOK) {
                NSSet *touches = [NSSet setWithObject:t];
                // Began phase
                @try {
                    [t setValue:@(UITouchPhaseBegan) forKey:@"phase"];
                    [hit touchesBegan:touches withEvent:nil];
                } @catch (NSException *e) {}
                // Ended phase
                @try {
                    [t setValue:@(UITouchPhaseEnded) forKey:@"phase"];
                    [hit touchesEnded:touches withEvent:nil];
                } @catch (NSException *e) {}
                fired = YES;
                return;
            }
        }

        // Strategy 1: public accessibilityActivate. RN Pressable,
        // UIButton, UITextField, etc. wire this to their press
        // handler. Returns YES only when the action fires.
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
        // Strategy 3: walk the view chain for a UITapGestureRecognizer
        // and fire its private _handleAction. Catches RNGH BaseButton
        // wrappers when (1) and (2) miss.
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
