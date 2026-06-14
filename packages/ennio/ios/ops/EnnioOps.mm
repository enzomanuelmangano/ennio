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
// CLI drives HID after EnnioFinder hands back coords. This file
// only handles the special cases where UIKit-direct beats HID.
//

#import "EnnioOps.h"
#import "EnnioBootstrap.h"
#import "EnnioFinder.h"
#import "EnnioTestIDIndex.h"

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

// Set on a UIAlertController once one of its actions has been
// triggered. RN alerts (RCTAlertManager) share a SINGLE JS callback
// across every button — invoking a second handler on the same alert
// calls that callback twice, which TurboModule treats as fatal
// (glog CHECK → SIGABRT, observed crashing the host app when a caller
// re-tapped during the dismissal animation).
static const void *kEnnioAlertActioned = &kEnnioAlertActioned;

static UIAlertController *_Nullable findAlert(void) {
    for (UIWindow *w in allWindows()) {
        UIViewController *vc = w.rootViewController;
        while (vc) {
            if ([vc isKindOfClass:UIAlertController.class]) {
                UIAlertController *a = (UIAlertController *)vc;
                // An alert on its way out is not actionable: its handler
                // (if any) already fired, and reporting it present makes
                // callers re-tap it. Skip dismissing and already-actioned
                // alerts so alert_present flips false the moment a button
                // is pressed.
                BOOL spent = a.isBeingDismissed ||
                             objc_getAssociatedObject(a, kEnnioAlertActioned) != nil;
                if (!spent) return a;
                break; // nothing actionable below a presented alert
            }
            UIViewController *presented = vc.presentedViewController;
            if (!presented) break;
            vc = presented;
        }
    }
    return nil;
}

static UITabBarController *_Nullable findTabBarController(void) {
    // BFS through every VC reachable from any window: rootViewController,
    // its presentedViewController chain, and all descendants via
    // childViewControllers (recursive). Expo Router + react-native-screens
    // host the UITabBarController (RNSTabBarController subclass) as a
    // child two levels deep inside RNSBottomTabsHostComponentView; a
    // shallow walk misses it and the UIKit-direct tab fallback returns
    // tapped=false on every tab tap.
    NSMutableArray<UIViewController *> *queue = [NSMutableArray new];
    for (UIWindow *w in allWindows()) {
        if (w.rootViewController) [queue addObject:w.rootViewController];
    }
    while (queue.count) {
        UIViewController *vc = queue.firstObject;
        [queue removeObjectAtIndex:0];
        if ([vc isKindOfClass:UITabBarController.class]) return (UITabBarController *)vc;
        for (UIViewController *child in vc.childViewControllers) [queue addObject:child];
        if (vc.presentedViewController) [queue addObject:vc.presentedViewController];
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

// Find the enclosing scroll view that actually scrolls in the swipe's AXIS.
// A horizontal page-swipe over (say) a Contacts list must drive the PAGER, not
// the inner vertical list — but the innermost scroll view is the list. Walk up
// and pick the first scroll view scrollable on the requested axis (content
// exceeds the frame there, or it pages on that axis).
static UIScrollView *_Nullable findScrollViewForAxis(UIView *view, BOOL horizontal) {
    for (UIView *v = view; v; v = v.superview) {
        if (![v isKindOfClass:UIScrollView.class]) continue;
        UIScrollView *sv = (UIScrollView *)v;
        BOOL scrollsH = sv.contentSize.width > sv.frame.size.width + 1.0;
        BOOL scrollsV = sv.contentSize.height > sv.frame.size.height + 1.0;
        if ((horizontal && scrollsH) || (!horizontal && scrollsV)) return sv;
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
        // Mark BEFORE dismissing: findAlert skips actioned alerts, so a
        // second tap during the (async) dismissal can't reach this alert
        // and double-invoke the shared RN callback.
        objc_setAssociatedObject(a, kEnnioAlertActioned, @YES,
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
    objc_setAssociatedObject(a, kEnnioAlertActioned, @YES,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
    // Already on the target tab — pop to root (same as a real tab bar
    // re-tap) so the caller lands on the tab's index screen, not deep
    // inside a pushed route left over from a previous flow.
    if (tbc.selectedIndex == (NSUInteger)idx) {
        UIViewController *vc = tbc.viewControllers[idx];
        // Direct UINavigationController
        if ([vc isKindOfClass:UINavigationController.class]) {
            [(UINavigationController *)vc popToRootViewControllerAnimated:NO];
        } else {
            // Expo-router wraps tabs in container VCs — BFS for a
            // UINavigationController child and pop that.
            NSMutableArray<UIViewController *> *q = [NSMutableArray arrayWithObject:vc];
            while (q.count) {
                UIViewController *c = q.firstObject;
                [q removeObjectAtIndex:0];
                if ([c isKindOfClass:UINavigationController.class]) {
                    [(UINavigationController *)c popToRootViewControllerAnimated:NO];
                    break;
                }
                [q addObjectsFromArray:c.childViewControllers];
            }
        }
        // Dismiss any modally presented VC on this tab too.
        if (vc.presentedViewController) {
            [vc dismissViewControllerAnimated:NO completion:nil];
        }
        return YES;
    }
    UIViewController *target = tbc.viewControllers[idx];
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

+ (BOOL)isTabSelectedByName:(NSString *)name {
    UITabBarController *tbc = findTabBarController();
    if (!tbc) return NO;
    NSInteger idx = findTabIndex(tbc, name);
    if (idx == NSNotFound) return NO;
    return tbc.selectedIndex == (NSUInteger)idx;
}

// ─── Navigation ─────────────────────────────────────────────────────

+ (BOOL)backGesture {
    // Synchronous variant — caller (CLI's `back` handler) waits the
    // post-tap settle by polling animations_active separately.
    // Previous semaphore + transitionCoordinator completion variant
    // intermittently deadlocked on slower CI runners when main was
    // already busy processing the prior step's render queue.
    UINavigationController *nav = findTopNavController();
    if (nav && nav.viewControllers.count >= 2) {
        [nav popViewControllerAnimated:YES];
        return YES;
    }
    UIWindow *win = [EnnioBootstrap keyWindow];
    UIViewController *vc = win.rootViewController;
    while (vc.presentedViewController) vc = vc.presentedViewController;
    if (vc && vc.presentingViewController) {
        [vc dismissViewControllerAnimated:YES completion:nil];
        return YES;
    }
    return NO;
}

// Check ONLY a VC's root view layer for a position/transform/opacity
// animation. RN-Screens and react-native-reanimated drive sheet
// present/dismiss as CAAnimations on the host view's layer — these
// don't surface as UIViewController.isBeingPresented because the
// host VC is already mounted. Walking the entire subview tree was
// too slow (1.6 s/call on screens with persistent spinner CAAnimations
// elsewhere). Only the immediate presentation host's layer matters
// for the "sheet still sliding in" case — its sub-animations
// (button highlights, spinners) are noise.
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

    // scrollRectToVisible trusts adjustedContentInset — but RN sets
    // contentInsetAdjustmentBehavior=never by default, so the scroll
    // view believes it is full-bleed while the floating tab bar / nav
    // header overlays its content. Occlusion-aware correction: hitTest
    // at the target's center; if the hit lands OUTSIDE the target's
    // subtree, measure the occluder's overlap and scroll exactly past
    // it. Signal-driven (the occluder's real frame), no magic
    // distances; capped at 4 iterations.
    UIWindow *win = target.window;
    if (!win) return YES;
    for (int i = 0; i < 4; i++) {
        [sv layoutIfNeeded];
        CGRect inWin = [target convertRect:target.bounds toView:nil];
        CGPoint center = CGPointMake(CGRectGetMidX(inWin), CGRectGetMidY(inWin));
        UIView *hit = [win hitTest:center withEvent:nil];
        BOOL exposed = NO;
        for (UIView *cur = hit; cur; cur = cur.superview) {
            if (cur == target) { exposed = YES; break; }
        }
        if (exposed || !hit) break;
        CGRect occluder = [hit convertRect:hit.bounds toView:nil];
        CGPoint offset = sv.contentOffset;
        if (CGRectGetMinY(occluder) > CGRectGetMidY(inWin) - 1 ||
            CGRectGetMaxY(occluder) > CGRectGetMaxY(inWin)) {
            // Occluder below/overlapping bottom (tab bar): scroll the
            // content up by the overlap so the target clears its top.
            offset.y += CGRectGetMaxY(inWin) - CGRectGetMinY(occluder) + 8;
        } else {
            // Occluder above (nav header): scroll content down.
            offset.y -= CGRectGetMaxY(occluder) - CGRectGetMinY(inWin) + 8;
        }
        CGSize content = sv.contentSize;
        CGSize frame = sv.frame.size;
        UIEdgeInsets ins = sv.adjustedContentInset;
        CGFloat maxY = MAX(0, content.height - frame.height + ins.bottom);
        offset.y = MAX(-ins.top, MIN(offset.y, maxY));
        if (fabs(offset.y - sv.contentOffset.y) < 0.5) break; // clamped, can't improve
        [sv setContentOffset:offset animated:NO];
    }
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

// ─── First-responder resolution (shared by text/key ops) ────────────
//
// Find the UIKeyInput first responder by descending the view tree
// from every window + presented-VC chain. Two subtleties:
//   1. The responder-chain *upward* path (view → … → window → app)
//      never reaches it — firstResponder lives DOWN in the subview
//      tree, so we walk down.
//   2. Acceptance requires UIKeyInput, not just isFirstResponder:
//      wrapper views proxy isFirstResponder for their inner field
//      (UISearchBar reports YES but can't take keys; its descendant
//      UISearchBarTextField also reports YES and can). Stopping at
//      the wrapper made every native-search-bar insert/backspace
//      fail (g-search-bar).
static UIResponder *EnnioFindKeyInputResponder(void) {
    __block UIResponder *first = nil;
    void (^findFirst)(UIView *) = nil;
    __block __weak void (^weakFind)(UIView *);
    weakFind = findFirst = ^(UIView *v) {
        if (first) return;
        if (v.isFirstResponder && [v conformsToProtocol:@protocol(UIKeyInput)]) {
            first = v;
            return;
        }
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
            // Walk the rootVC's presented-VC chain. Sheet presentation
            // controllers host their content detached from the window's
            // literal subview tree — the firstResponder lives there but
            // findFirst(window) misses it.
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
    return first;
}

// ─── Hardware key ───────────────────────────────────────────────────

+ (BOOL)pressHardwareKey:(int)keyCode {
    UIResponder *first = EnnioFindKeyInputResponder();
    if (!first) {
        NSLog(@"[Ennio] pressHardwareKey: no UIKeyInput first responder");
        return NO;
    }
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
    // controls or sibling Pressables sharing a hit region, this
    // can resolve to the wrong target.
    SEL tap = NSSelectorFromString(@"_accessibilityHandleUserTouchActivate");
    if ([v respondsToSelector:tap]) {
        IMP imp = [v methodForSelector:tap];
        ((void (*)(id, SEL))imp)(v, tap);
        return YES;
    }
    // Try the public accessibilityActivate first now — RN Fabric's
    // Pressable wires `onPress` through this by setting an
    // accessibility-activation block on the view. Cheaper and more
    // reliable on Fabric than the gesture-recogniser walk.
    if ([v accessibilityActivate]) return YES;
    // Walk ancestor chain for any UITapGestureRecognizer that
    // exposes _handleAction (TouchableX / RNGH GestureHandlerButton).
    for (UIView *cur = v; cur; cur = cur.superview) {
        for (UIGestureRecognizer *g in cur.gestureRecognizers) {
            if (!g.isEnabled) continue;
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
    // Subview walk — RN Pressable in Fabric occasionally hosts the
    // tap recogniser on a child responder view (RCTSurfaceTouchHandler
    // adapter / RCTPressabilityProxy). Try them all before giving up.
    NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:v];
    while (stack.count) {
        UIView *cur = stack.lastObject;
        [stack removeLastObject];
        for (UIGestureRecognizer *g in cur.gestureRecognizers) {
            if (!g.isEnabled) continue;
            if ([g isKindOfClass:UITapGestureRecognizer.class]) {
                SEL fire = NSSelectorFromString(@"_handleAction");
                if ([g respondsToSelector:fire]) {
                    IMP imp = [g methodForSelector:fire];
                    ((void (*)(id, SEL))imp)(g, fire);
                    return YES;
                }
            }
        }
        for (UIView *sub in cur.subviews) [stack addObject:sub];
    }
    return NO;
}

+ (BOOL)activateByTestID:(NSString *)testID {
    // Use the same topmost-Y disambiguation as find_by_testid so the
    // activate fallback fires the same logical view our gesture-tap
    // would target. Legacy findViewByTestID returns the last-registered
    // entry which can be a detached or off-screen remount.
    NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
    UIView *v = all.firstObject ?: [EnnioFinder findViewByTestID:testID];
    return [self activateView:v];
}

+ (BOOL)focusByTestID:(NSString *)testID {
    // Prefer the on-screen match (topmost in Y), NOT findViewByTestID's
    // last-registered entry — after a composer publishes and reopens
    // (consecutive replies) that's the DETACHED previous field; focusing
    // it "succeeds" but the live composer stays empty so canPost never
    // flips and the publish button never shows.
    NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
    UIView *v = nil;
    for (UIView *cand in all) { if ([EnnioFinder isOnScreen:cand]) { v = cand; break; } }
    if (!v) v = all.firstObject ?: [EnnioFinder findViewByTestID:testID];
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
    if (![v becomeFirstResponder]) return NO;
    // Verify the focus actually landed on a TEXT INPUT inside the
    // target. becomeFirstResponder can return YES for non-input views
    // (a Pressable like replyBtn) — the CLI uses ok=true to SKIP the
    // real tap entirely, so a false positive here swallows the press
    // (thread-muting: tapOn replyBtn + next inputText never opened the
    // composer). Identity, not existence: the UIKeyInput responder must
    // live within the target's subtree.
    UIResponder *first = EnnioFindKeyInputResponder();
    if (!first || ![first isKindOfClass:UIView.class]) return NO;
    for (UIView *cur = (UIView *)first; cur; cur = cur.superview) {
        if (cur == v) return YES;
    }
    return NO;
}

+ (UIView *)firstEditableTextInput {
    // Walk every window + presented-VC chain (sheets host content
    // detached from the window subtree, same as EnnioFindKeyInputResponder)
    // and collect on-screen editable text inputs. "Editable" is identity,
    // not class: conforms to UIKeyInput AND canBecomeFirstResponder — that
    // accepts RCTUITextField / UITextView / UISearchBarTextField and
    // rejects disabled fields, without enumerating subclasses. Return the
    // topmost (smallest window-Y) so a screen with several inputs focuses
    // the first the user would, deterministically.
    __block UIView *best = nil;
    __block double bestY = 0;
    void (^scan)(UIView *) = nil;
    __block __weak void (^weakScan)(UIView *);
    weakScan = scan = ^(UIView *v) {
        if (v.hidden || v.alpha < 0.01) return;
        if ([v conformsToProtocol:@protocol(UIKeyInput)] &&
            [v canBecomeFirstResponder] && v.userInteractionEnabled &&
            [EnnioFinder isOnScreen:v]) {
            EnnioRect r = [EnnioFinder windowRectFor:v];
            if (r.w > 0 && r.h > 0 && (!best || r.y < bestY)) {
                best = v;
                bestY = r.y;
            }
        }
        for (UIView *sub in v.subviews) weakScan(sub);
    };
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            scan(w);
            UIViewController *vc = w.rootViewController;
            while (vc) {
                UIView *vcView = vc.viewIfLoaded;
                if (vcView && !vcView.superview) scan(vcView);
                vc = vc.presentedViewController;
            }
        }
    }
    return best;
}

+ (BOOL)insertText:(NSString *)text {
    UIResponder *first = EnnioFindKeyInputResponder();
    if (!first) {
        NSLog(@"[Ennio] insertText: no UIKeyInput first responder");
        return NO;
    }
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
    // Pick the scroll view that scrolls in the swipe's axis — a horizontal page
    // swipe must drive the PAGER, not an inner vertical list it happens to start
    // over.
    BOOL horizontalSwipe = fabs(x1 - x2) >= fabs(y1 - y2);
    UIScrollView *sv = hit ? findScrollViewForAxis(hit, horizontalSwipe) : nil;
    // Paging scroll view (an RN pager / material-top-tabs / UIPageViewController
    // scroll-style): advance EXACTLY ONE page in the swipe direction, with
    // animated:YES. A momentum HID drag is the wrong primitive here — the page
    // delta depends on fling velocity (too slow advances zero pages, too fast
    // skips one), so NO fixed gesture distance is deterministic. One page-width
    // setContentOffset with animated:YES drives scrollViewDidEndScrollingAnimation,
    // which paging scroll views commit their page index on — unlike animated:NO,
    // which moves the offset but leaves the page stale (the old reason this
    // declined to HID).
    if (sv && sv.isPagingEnabled) {
        CGFloat pageW = sv.frame.size.width;
        CGFloat pageH = sv.frame.size.height;
        CGFloat ddx = x1 - x2;
        CGFloat ddy = y1 - y2;
        CGPoint offset = sv.contentOffset;
        if (fabs(ddx) >= fabs(ddy)) offset.x += (ddx > 0 ? pageW : -pageW);
        else offset.y += (ddy > 0 ? pageH : -pageH);
        CGSize content = sv.contentSize;
        CGSize frame = sv.frame.size;
        UIEdgeInsets ins = sv.adjustedContentInset;
        offset.x = MAX(-ins.left, MIN(offset.x, MAX(0, content.width - frame.width + ins.right)));
        offset.y = MAX(-ins.top, MIN(offset.y, MAX(0, content.height - frame.height + ins.bottom)));
        [sv setContentOffset:offset animated:YES];
        return YES;
    }
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
    // back to host HID for a real UITouch sequence — synthesising
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
