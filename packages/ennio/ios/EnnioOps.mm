//
// EnnioOps.mm
//
// UIKit operations called from socket handlers. Each method finds the
// relevant UIKit object (UIAlertController, UITabBarController, etc.)
// by walking window scenes, then drives it via documented UIKit APIs.
//
// Why direct UIKit instead of synthesizing UITouch via IOHID for these
// specific cases:
//
//   - Tab bar taps: UITabBarController delegate + selectedViewController
//     fires reliably; a HID tap on the tab bar is flaky on iOS 26 when
//     the destination tab does first-render work.
//   - Alert button taps: UIAlertController action invocation is
//     deterministic; HID taps on alerts cross window-scene boundaries
//     and sometimes route to nothing.
//   - Back navigation: UINavigationController popViewController bypasses
//     the slide-from-edge gesture that's hard to drive cleanly.
//
// For "real touch" semantics (Pressable, RNGH BaseButton, etc.) the
// CLI drives idb HID after EnnioFinder hands back coords. This file
// only handles the special cases where UIKit-direct beats HID.
//

#import "EnnioOps.h"
#import "EnnioBootstrap.h"
#import "EnnioFinder.h"

#import <objc/runtime.h>


// ─── helpers ────────────────────────────────────────────────────────

static NSArray<UIWindow *> *allWindows(void) {
    NSMutableArray<UIWindow *> *out = [NSMutableArray new];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            if (!w.hidden) [out addObject:w];
        }
    }
    return out;
}

static UIViewController *rootVC(void) {
    UIWindow *win = [EnnioBootstrap keyWindow];
    return win.rootViewController;
}

static UIAlertController *_Nullable findAlert(void) {
    for (UIWindow *w in allWindows()) {
        UIViewController *vc = w.rootViewController;
        while (vc) {
            if ([vc isKindOfClass:UIAlertController.class]) return (UIAlertController *)vc;
            UIViewController *presented = vc.presentedViewController;
            if (!presented) break;
            vc = presented;
        }
    }
    return nil;
}

static UITabBarController *_Nullable findTabBarController(void) {
    for (UIWindow *w in allWindows()) {
        UIViewController *vc = w.rootViewController;
        // Walk presented chain first, then handle nested in nav.
        while (vc) {
            if ([vc isKindOfClass:UITabBarController.class]) return (UITabBarController *)vc;
            if ([vc isKindOfClass:UINavigationController.class]) {
                UIViewController *top = ((UINavigationController *)vc).topViewController;
                if ([top isKindOfClass:UITabBarController.class])
                    return (UITabBarController *)top;
            }
            UIViewController *presented = vc.presentedViewController;
            if (!presented) {
                // Look at children for embedded tabbars
                for (UIViewController *child in vc.childViewControllers) {
                    if ([child isKindOfClass:UITabBarController.class])
                        return (UITabBarController *)child;
                }
                break;
            }
            vc = presented;
        }
    }
    return nil;
}

static UINavigationController *_Nullable findTopNavController(void) {
    for (UIWindow *w in allWindows()) {
        UIViewController *vc = w.rootViewController;
        // Walk presented chain to find the topmost VC.
        while (vc.presentedViewController) vc = vc.presentedViewController;
        // Try as nav, then drill into common containers.
        if ([vc isKindOfClass:UINavigationController.class]) return (UINavigationController *)vc;
        if ([vc isKindOfClass:UITabBarController.class]) {
            UIViewController *sel = ((UITabBarController *)vc).selectedViewController;
            if ([sel isKindOfClass:UINavigationController.class])
                return (UINavigationController *)sel;
        }
        for (UIViewController *child in vc.childViewControllers) {
            if ([child isKindOfClass:UINavigationController.class])
                return (UINavigationController *)child;
        }
    }
    return nil;
}

static UIScrollView *_Nullable findEnclosingScrollView(UIView *view) {
    for (UIView *v = view; v; v = v.superview) {
        if ([v isKindOfClass:UIScrollView.class]) return (UIScrollView *)v;
    }
    return nil;
}

// ─── EnnioOps ───────────────────────────────────────────────────────

@implementation EnnioOps

// ─── Alerts ─────────────────────────────────────────────────────────

+ (BOOL)isAlertPresent {
    return findAlert() != nil;
}

+ (NSString *)alertText {
    UIAlertController *a = findAlert();
    if (!a) return @"";
    NSString *t = a.title ?: @"";
    NSString *m = a.message ?: @"";
    if (m.length) {
        return [NSString stringWithFormat:@"%@\n%@", t, m];
    }
    return t;
}

+ (NSArray<NSString *> *)alertButtons {
    UIAlertController *a = findAlert();
    if (!a) return @[];
    NSMutableArray<NSString *> *out = [NSMutableArray new];
    for (UIAlertAction *act in a.actions) {
        if (act.title) [out addObject:act.title];
    }
    return out;
}

+ (BOOL)tapAlertButton:(NSString *)buttonText {
    UIAlertController *a = findAlert();
    if (!a) return NO;
    for (UIAlertAction *act in a.actions) {
        if (![act.title isEqualToString:buttonText]) continue;
        // Read the handler block via KVC. UIAlertAction stores it as
        // `handler` (private but stable since iOS 8). KVC is ARC-safe
        // unlike object_getInstanceVariable.
        void (^handler)(UIAlertAction *) = nil;
        @try {
            id raw = [act valueForKey:@"handler"];
            if (raw) handler = (void (^)(UIAlertAction *))raw;
        } @catch (...) {
            // KVC fails -> no handler; treat as success (dismiss only).
        }
        // Dismiss first so the alert is gone by the time the handler
        // fires — matches what UIKit does on user tap.
        UIViewController *presenter = a.presentingViewController ?: rootVC();
        [presenter dismissViewControllerAnimated:NO completion:^{
            if (handler) handler(act);
        }];
        return YES;
    }
    return NO;
}

+ (BOOL)dismissAlert {
    UIAlertController *a = findAlert();
    if (!a) return NO;
    UIViewController *presenter = a.presentingViewController ?: rootVC();
    [presenter dismissViewControllerAnimated:NO completion:nil];
    return YES;
}

// ─── Tabs ───────────────────────────────────────────────────────────

static NSInteger findTabIndex(UITabBarController *tbc, NSString *name) {
    NSString *target = name.lowercaseString;
    NSInteger idx = 0;
    for (UIViewController *vc in tbc.viewControllers) {
        UITabBarItem *item = vc.tabBarItem;
        if ([item.title.lowercaseString isEqualToString:target]) return idx;
        if ([item.accessibilityIdentifier.lowercaseString isEqualToString:target]) return idx;
        if ([vc.title.lowercaseString isEqualToString:target]) return idx;
        idx++;
    }
    return NSNotFound;
}

+ (BOOL)tapTabByName:(NSString *)name {
    UITabBarController *tbc = findTabBarController();
    if (!tbc) return NO;
    NSInteger idx = findTabIndex(tbc, name);
    if (idx == NSNotFound) return NO;
    UIViewController *target = tbc.viewControllers[idx];
    // Fire delegate first (UIKit convention).
    if ([tbc.delegate respondsToSelector:@selector(tabBarController:shouldSelectViewController:)]) {
        BOOL ok = [tbc.delegate tabBarController:tbc shouldSelectViewController:target];
        if (!ok) return NO;
    }
    tbc.selectedIndex = idx;
    if ([tbc.delegate respondsToSelector:@selector(tabBarController:didSelectViewController:)]) {
        [tbc.delegate tabBarController:tbc didSelectViewController:target];
    }
    return YES;
}

+ (BOOL)findTabByName:(NSString *)name {
    UITabBarController *tbc = findTabBarController();
    if (!tbc) return NO;
    return findTabIndex(tbc, name) != NSNotFound;
}

// ─── Navigation ─────────────────────────────────────────────────────

+ (BOOL)backGesture {
    // First try popping a navigation stack — covers the common Stack
    // back-button case.
    UINavigationController *nav = findTopNavController();
    if (nav && nav.viewControllers.count >= 2) {
        [nav popViewControllerAnimated:YES];
        return YES;
    }
    // Fall back to dismissing the topmost presented modal (sheet,
    // formSheet, fullScreen). React Navigation's modal stack and
    // expo-router's modals both surface here. Without this, a YAML
    // `back` after presenting a modal goes nowhere and subsequent
    // tab taps land on the still-visible sheet.
    UIWindow *win = [EnnioBootstrap keyWindow];
    UIViewController *vc = win.rootViewController;
    while (vc.presentedViewController) vc = vc.presentedViewController;
    if (vc && vc.presentingViewController) {
        [vc dismissViewControllerAnimated:YES completion:nil];
        return YES;
    }
    return NO;
}

static BOOL anyVCInTransition(UIViewController *root) {
    if (!root) return NO;
    if (root.isBeingPresented || root.isBeingDismissed) return YES;
    if (root.transitionCoordinator) return YES;
    for (UIViewController *child in root.childViewControllers) {
        if (anyVCInTransition(child)) return YES;
    }
    if (root.presentedViewController) {
        if (anyVCInTransition(root.presentedViewController)) return YES;
    }
    return NO;
}

+ (uint32_t)waitForPresentationIdleWithTimeout:(uint32_t)maxMs {
    NSDate *start = [NSDate date];
    uint32_t step = 50;
    while (true) {
        __block BOOL inTransition = NO;
        dispatch_sync(dispatch_get_main_queue(), ^{
            UIWindow *win = [EnnioBootstrap keyWindow];
            UIViewController *root = win.rootViewController;
            if (anyVCInTransition(root)) inTransition = YES;
        });
        if (!inTransition) break;
        uint32_t elapsed = (uint32_t)([[NSDate date] timeIntervalSinceDate:start] * 1000);
        if (elapsed >= maxMs) break;
        [NSThread sleepForTimeInterval:step / 1000.0];
    }
    return (uint32_t)([[NSDate date] timeIntervalSinceDate:start] * 1000);
}

+ (BOOL)hideKeyboard {
    UIWindow *win = [EnnioBootstrap keyWindow];
    if (!win) return NO;
    [win endEditing:YES];
    return YES;
}

// ─── Scrolling ──────────────────────────────────────────────────────

+ (BOOL)scrollTestID:(NSString *)testID direction:(NSString *)direction distance:(double)distance {
    UIView *view = [EnnioFinder findViewByTestID:testID];
    if (!view) return NO;
    UIScrollView *sv = findEnclosingScrollView(view);
    if (!sv) return NO;
    CGPoint offset = sv.contentOffset;
    if ([direction isEqualToString:@"up"]) offset.y -= distance;
    else if ([direction isEqualToString:@"down"]) offset.y += distance;
    else if ([direction isEqualToString:@"left"]) offset.x -= distance;
    else if ([direction isEqualToString:@"right"]) offset.x += distance;
    else return NO;
    // Clamp.
    CGSize content = sv.contentSize;
    CGSize frame = sv.frame.size;
    UIEdgeInsets ins = sv.adjustedContentInset;
    CGFloat maxX = MAX(0, content.width - frame.width + ins.right);
    CGFloat maxY = MAX(0, content.height - frame.height + ins.bottom);
    offset.x = MAX(-ins.left, MIN(offset.x, maxX));
    offset.y = MAX(-ins.top, MIN(offset.y, maxY));
    [sv setContentOffset:offset animated:NO];
    return YES;
}

+ (BOOL)scrollViewWithTestID:(NSString *)scrollViewTestID toTestID:(NSString *)elementTestID {
    UIView *target = [EnnioFinder findViewByTestID:elementTestID];
    if (!target) return NO;
    UIScrollView *sv = nil;
    if (scrollViewTestID.length) {
        UIView *svView = [EnnioFinder findViewByTestID:scrollViewTestID];
        if ([svView isKindOfClass:UIScrollView.class]) sv = (UIScrollView *)svView;
    }
    if (!sv) sv = findEnclosingScrollView(target);
    if (!sv) return NO;
    CGRect rectInSv = [target convertRect:target.bounds toView:sv];
    [sv scrollRectToVisible:rectInSv animated:NO];
    return YES;
}

// ─── Clipboard ──────────────────────────────────────────────────────

+ (BOOL)clipboardCopy:(NSString *)text {
    UIPasteboard.generalPasteboard.string = text ?: @"";
    return YES;
}

+ (NSString *)clipboardText {
    return UIPasteboard.generalPasteboard.string ?: @"";
}

+ (BOOL)clipboardPasteIntoTestID:(NSString *)testID {
    UIView *view = [EnnioFinder findViewByTestID:testID];
    if (!view) return NO;
    // Make the view the first responder if possible, then dispatch
    // paste: through the responder chain. Same path the system uses.
    if (![view becomeFirstResponder]) return NO;
    UIApplication *app = UIApplication.sharedApplication;
    return [app sendAction:@selector(paste:) to:nil from:view forEvent:nil];
}

// ─── Hardware key ───────────────────────────────────────────────────

+ (BOOL)pressHardwareKey:(int)keyCode {
    // Find the current first responder by descending the view tree
    // from every window. The responder-chain *upward* path goes
    // view → … → window → app → nil; firstResponder lives DOWN in
    // the subview tree (typically a UITextField/UITextView), so the
    // upward walk from a window never sees it.
    __block UIResponder *first = nil;
    void (^findFirst)(UIView *) = nil;
    __block __weak void (^weakFind)(UIView *);
    weakFind = findFirst = ^(UIView *v) {
        if (first) return;
        if (v.isFirstResponder) { first = v; return; }
        for (UIView *sub in v.subviews) {
            weakFind(sub);
            if (first) return;
        }
    };
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            findFirst(w);
            if (first) break;
        }
        if (first) break;
    }
    if (!first) {
        UIWindow *win = [EnnioBootstrap keyWindow];
        if (win) findFirst(win);
    }
    if (![first conformsToProtocol:@protocol(UIKeyInput)]) return NO;
    id<UIKeyInput> input = (id<UIKeyInput>)first;
    switch (keyCode) {
        case 42: // backspace
            if ([input respondsToSelector:@selector(deleteBackward)]) [input deleteBackward];
            return YES;
        case 40: // return — fire onSubmitEditing-style action when
                 // the firstResponder is a UITextField/UIControl,
                 // so RN's TextInput.onSubmitEditing callback runs.
                 // Falls back to a literal newline insert for
                 // multiline fields.
            if ([first isKindOfClass:UIControl.class]) {
                UIControl *ctl = (UIControl *)first;
                [ctl sendActionsForControlEvents:UIControlEventEditingDidEndOnExit];
                if ([first isKindOfClass:UITextField.class]) {
                    UITextField *tf = (UITextField *)first;
                    id<UITextFieldDelegate> d = tf.delegate;
                    if ([d respondsToSelector:@selector(textFieldShouldReturn:)]) {
                        [d textFieldShouldReturn:tf];
                    }
                }
            } else {
                [input insertText:@"\n"];
            }
            return YES;
        case 44: // space
            [input insertText:@" "];
            return YES;
        default:
            return NO;
    }
}

+ (BOOL)triggerRefreshAtX:(double)x y:(double)y {
    UIWindow *win = [EnnioBootstrap keyWindow];
    if (!win) return NO;
    UIView *hit = [win hitTest:CGPointMake(x, y) withEvent:nil];
    UIScrollView *sv = hit ? findEnclosingScrollView(hit) : nil;
    if (!sv) return NO;
    UIRefreshControl *rc = sv.refreshControl;
    if (!rc) return NO;
    // Skip if a refresh is already in progress — repeated downward
    // swipes in YAML (warm-up + actual trigger) would otherwise fire
    // valueChanged multiple times and inflate the test's hit counter.
    if (rc.isRefreshing) return YES;
    [rc beginRefreshing];
    [rc sendActionsForControlEvents:UIControlEventValueChanged];
    return YES;
}

+ (BOOL)isRefreshingAtX:(double)x y:(double)y {
    UIWindow *win = [EnnioBootstrap keyWindow];
    if (!win) return NO;
    UIView *hit = [win hitTest:CGPointMake(x, y) withEvent:nil];
    UIScrollView *sv = hit ? findEnclosingScrollView(hit) : nil;
    return sv && sv.refreshControl && sv.refreshControl.isRefreshing;
}

+ (UIView *)findChildTestID:(NSString *)childTestID inParentTestID:(NSString *)parentTestID {
    UIView *parent = [EnnioFinder findViewByTestID:parentTestID];
    if (!parent) return nil;
    NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:parent];
    while (stack.count) {
        UIView *cur = stack.lastObject;
        [stack removeLastObject];
        if ([cur.accessibilityIdentifier isEqualToString:childTestID]) return cur;
        for (UIView *sub in cur.subviews) [stack addObject:sub];
    }
    return nil;
}

+ (BOOL)activateView:(UIView *)v {
    if (!v) return NO;
    // Prefer onAccessibilityTap — direct callback delivery, no
    // synthesized touch + hit-test indirection. UIView's default
    // accessibilityActivate synthesizes a tap at the view's
    // activation point and re-hit-tests; for stacked 1×1 px e2e
    // controls (Bluesky), this can resolve to the wrong sibling.
    SEL tap = NSSelectorFromString(@"_accessibilityHandleUserTouchActivate");
    if ([v respondsToSelector:tap]) {
        // Private but stable since iOS 10.
        IMP imp = [v methodForSelector:tap];
        ((void (*)(id, SEL))imp)(v, tap);
        return YES;
    }
    // Find the first UIGestureRecognizer in the view's chain whose
    // target action looks like a Pressable / TouchableX onPress and
    // invoke it via the recognizer's _handleAction selector.
    for (UIView *cur = v; cur; cur = cur.superview) {
        for (UIGestureRecognizer *g in cur.gestureRecognizers) {
            if (!g.isEnabled) continue;
            // RNGH's GestureHandlerButton uses UITapGestureRecognizer.
            if ([g isKindOfClass:UITapGestureRecognizer.class]) {
                SEL fire = NSSelectorFromString(@"_handleAction");
                if ([g respondsToSelector:fire]) {
                    IMP imp = [g methodForSelector:fire];
                    ((void (*)(id, SEL))imp)(g, fire);
                    return YES;
                }
            }
        }
    }
    // Last resort: the original accessibilityActivate, in case the
    // view has overridden it usefully.
    if ([v accessibilityActivate]) return YES;
    return NO;
}

+ (BOOL)activateByTestID:(NSString *)testID {
    UIView *v = [EnnioFinder findViewByTestID:testID];
    return [self activateView:v];
}

+ (BOOL)focusByTestID:(NSString *)testID {
    UIView *v = [EnnioFinder findViewByTestID:testID];
    if (!v) return NO;
    // RCTBaseTextInputView wraps the actual UITextField/UITextView in a
    // child; ask becomeFirstResponder on the wrapper and let UIKit
    // descend.
    if (![v canBecomeFirstResponder]) {
        UIView *inner = nil;
        NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:v];
        while (stack.count) {
            UIView *cur = stack.lastObject;
            [stack removeLastObject];
            if ([cur canBecomeFirstResponder]) {
                inner = cur;
                break;
            }
            for (UIView *sub in cur.subviews) [stack addObject:sub];
        }
        if (inner) v = inner;
    }
    return [v becomeFirstResponder];
}

+ (BOOL)insertText:(NSString *)text {
    __block UIResponder *first = nil;
    void (^findFirst)(UIView *) = nil;
    __block __weak void (^weakFind)(UIView *);
    weakFind = findFirst = ^(UIView *v) {
        if (first) return;
        if (v.isFirstResponder) { first = v; return; }
        for (UIView *sub in v.subviews) {
            weakFind(sub);
            if (first) return;
        }
    };
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            findFirst(w);
            if (first) break;
            // Walk the rootVC's presented-VC chain. UISheetPresentationController
            // hosts its content view detached from the window's literal
            // subview tree — the firstResponder lives there but
            // findFirst(window) misses it. Bluesky's @discord/bottom-sheet
            // routes every modal form (create-list, edit-profile, etc.)
            // through this path.
            UIViewController *vc = w.rootViewController;
            while (vc && !first) {
                UIView *vcView = vc.viewIfLoaded;
                if (vcView) findFirst(vcView);
                vc = vc.presentedViewController;
            }
            if (first) break;
        }
        if (first) break;
    }
    if (!first) {
        UIWindow *win = [EnnioBootstrap keyWindow];
        if (win) findFirst(win);
    }
    if (![first conformsToProtocol:@protocol(UIKeyInput)]) return NO;
    id<UIKeyInput> input = (id<UIKeyInput>)first;
    [input insertText:text];
    return YES;
}

// ─── Swipe at points ────────────────────────────────────────────────

+ (BOOL)swipeFromX:(double)x1 y:(double)y1 toX:(double)x2 y:(double)y2 durationMs:(double)durationMs {
    UIWindow *win = [EnnioBootstrap keyWindow];
    if (!win) return NO;

    // Fast path: if the start point lies inside a UIScrollView, just
    // setContentOffset. No UITouch synthesis tax.
    CGPoint startInWin = CGPointMake(x1, y1);
    UIView *hit = [win hitTest:startInWin withEvent:nil];
    UIScrollView *sv = hit ? findEnclosingScrollView(hit) : nil;
    if (sv) {
        CGFloat dx = x1 - x2;
        CGFloat dy = y1 - y2;
        CGPoint offset = sv.contentOffset;
        offset.x += dx;
        offset.y += dy;
        CGSize content = sv.contentSize;
        CGSize frame = sv.frame.size;
        UIEdgeInsets ins = sv.adjustedContentInset;
        CGFloat maxX = MAX(0, content.width - frame.width + ins.right);
        CGFloat maxY = MAX(0, content.height - frame.height + ins.bottom);
        offset.x = MAX(-ins.left, MIN(offset.x, maxX));
        offset.y = MAX(-ins.top, MIN(offset.y, maxY));
        [sv setContentOffset:offset animated:NO];
        return YES;
    }

    // Slow path: not over a scroll view. Return NO so the CLI falls
    // back to idb HID for a real UITouch sequence — synthesising
    // UITouch from native land requires private API (UIInternalEvent /
    // _UIPhysicalKeyboardEvent equivalents). Honest "unsupported in
    // this code path" so the orchestration layer routes correctly.
    return NO;
}

// ─── Sandbox ────────────────────────────────────────────────────────

+ (BOOL)clearAppData {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *home = NSHomeDirectory();
    NSArray<NSString *> *paths = @[
        [home stringByAppendingPathComponent:@"Library"],
        [home stringByAppendingPathComponent:@"Documents"],
        [home stringByAppendingPathComponent:@"tmp"],
    ];
    BOOL ok = YES;
    for (NSString *dir in paths) {
        NSError *err = nil;
        NSArray<NSString *> *contents = [fm contentsOfDirectoryAtPath:dir error:&err];
        if (err) continue;
        for (NSString *entry in contents) {
            // Skip ennio markers + caches we explicitly want to keep
            // (the listener socket is in /tmp, not the sandbox tmp).
            if ([entry hasPrefix:@"_ennio_"]) continue;
            NSString *full = [dir stringByAppendingPathComponent:entry];
            NSError *rmErr = nil;
            [fm removeItemAtPath:full error:&rmErr];
            if (rmErr) ok = NO;
        }
    }
    return ok;
}

@end
