//
// EnnioFinder.mm
//
// Recursive UIView walk + weak-ref cache. The walk visits ALL subviews
// regardless of `isAccessibilityElement` (which XCTest respects but
// in-process tools don't have to). This is the architectural advantage
// over WDA-based tools — sees views the accessibility daemon hides.
//
// Cache stores NSMapTable<NSString*, UIView*> with weak values: when
// the UIView deallocates the entry vanishes automatically. Cache is
// invalidated wholesale by clear_state; otherwise it grows with usage
// and self-prunes via the weak-ref mechanism.
//

#import "EnnioFinder.h"
#import "EnnioBootstrap.h"

static NSMapTable<NSString *, UIView *> *g_cache;
static dispatch_once_t g_cacheOnce;

static void ensureCache(void) {
    dispatch_once(&g_cacheOnce, ^{
        g_cache = [NSMapTable strongToWeakObjectsMapTable];
    });
}

static UIView *_Nullable cacheLookup(NSString *testID) {
    ensureCache();
    UIView *view = nil;
    @synchronized(g_cache) {
        view = [g_cache objectForKey:testID];
    }
    if (!view) return nil;
    // Validate: still attached + identifier still matches. If not,
    // remove from cache and report miss.
    if (!view.window) {
        @synchronized(g_cache) { [g_cache removeObjectForKey:testID]; }
        return nil;
    }
    if (![view.accessibilityIdentifier isEqualToString:testID]) {
        @synchronized(g_cache) { [g_cache removeObjectForKey:testID]; }
        return nil;
    }
    return view;
}

static void cacheStore(NSString *testID, UIView *view) {
    ensureCache();
    @synchronized(g_cache) {
        [g_cache setObject:view forKey:testID];
    }
}

// Recursive walk. Returns the first matching view found via DFS.
// Visits ALL subviews — `isAccessibilityElement` is intentionally NOT
// respected (in-process advantage).
static UIView *_Nullable walkByID(UIView *root, NSString *testID) {
    if (!root) return nil;
    if ([root.accessibilityIdentifier isEqualToString:testID]) return root;
    for (UIView *sub in root.subviews) {
        UIView *match = walkByID(sub, testID);
        if (match) return match;
    }
    return nil;
}

// Whether the view (or a near ancestor) is interactive — UIControl,
// UIButton, has a tap recognizer, or is an accessibility button trait.
// Used to break ties when multiple views match the same text: a tab
// bar item beats a header label.
static BOOL isInteractive(UIView *v) {
    if (!v) return NO;
    UIView *cur = v;
    for (int hop = 0; hop < 4 && cur; hop++, cur = cur.superview) {
        if (cur.userInteractionEnabled) {
            if ([cur isKindOfClass:UIControl.class]) return YES;
            if ([cur isKindOfClass:UIButton.class]) return YES;
            for (UIGestureRecognizer *g in cur.gestureRecognizers) {
                if (g.isEnabled) return YES;
            }
            UIAccessibilityTraits t = cur.accessibilityTraits;
            if ((t & UIAccessibilityTraitButton) || (t & UIAccessibilityTraitLink)) return YES;
            // RNGH wraps every Pressable in a view class that ends in
            // "GestureHandlerButton" — it accepts taps but doesn't
            // subclass UIControl. Detect by class name suffix.
            NSString *cls = NSStringFromClass([cur class]);
            if ([cls hasSuffix:@"GestureHandlerButton"]) return YES;
            if ([cls hasSuffix:@"RCTSinglelineTextInputView"]) return YES;
            if ([cls hasSuffix:@"RCTMultilineTextInputView"]) return YES;
        }
    }
    return NO;
}

static BOOL viewMatchesText(UIView *v, NSString *text) {
    if ([v.accessibilityLabel isEqualToString:text]) return YES;
    if ([v.accessibilityValue isEqualToString:text]) return YES;
    if ([v isKindOfClass:UILabel.class]) {
        UILabel *lbl = (UILabel *)v;
        if ([lbl.text isEqualToString:text]) return YES;
    }
    if ([v isKindOfClass:UIButton.class]) {
        UIButton *btn = (UIButton *)v;
        NSString *title = [btn titleForState:UIControlStateNormal];
        if ([title isEqualToString:text]) return YES;
    }
    return NO;
}

// Collect every matching view (preorder DFS). Used to pick the best
// candidate — interactive views beat plain text labels.
static void collectByText(UIView *root, NSString *text, NSMutableArray<UIView *> *out) {
    if (!root) return;
    if (viewMatchesText(root, text)) [out addObject:root];
    for (UIView *sub in root.subviews) collectByText(sub, text, out);
}

static UIView *_Nullable walkByText(UIView *root, NSString *text) {
    if (!root) return nil;
    NSMutableArray<UIView *> *matches = [NSMutableArray new];
    collectByText(root, text, matches);
    // Prefer interactive matches (tab bar items, buttons) over plain
    // labels (screen titles, headers).
    for (UIView *v in matches) {
        if (isInteractive(v)) return v;
    }
    return matches.firstObject;
}

// Walk every UIWindow of every UIWindowScene — modal sheets and alerts
// live in their own UIWindow. Returns the first match across all.
static UIView *_Nullable walkAllWindows(BOOL (^matcher)(UIView *)) {
    NSMutableArray<UIWindow *> *windows = [NSMutableArray new];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            if (!w.hidden) [windows addObject:w];
        }
    }
    // Iterate top-down (last-presented first) so an alert beats a
    // covered view of the same testID.
    for (UIWindow *w in windows.reverseObjectEnumerator) {
        NSMutableArray<UIView *> *stack = [NSMutableArray new];
        [stack addObject:w];
        while (stack.count) {
            UIView *v = stack.lastObject;
            [stack removeLastObject];
            if (matcher(v)) return v;
            for (UIView *sub in v.subviews) [stack addObject:sub];
        }
    }
    return nil;
}

@implementation EnnioFinder

+ (UIView *)findViewByTestID:(NSString *)testID {
    if (testID.length == 0) return nil;
    UIView *cached = cacheLookup(testID);
    if (cached) return cached;

    UIWindow *keyWin = [EnnioBootstrap keyWindow];
    UIView *match = walkByID(keyWin, testID);
    if (!match) {
        // Search every window (modals, alerts, separate scenes).
        match = walkAllWindows(^BOOL(UIView *v) {
            return [v.accessibilityIdentifier isEqualToString:testID];
        });
    }
    if (match) cacheStore(testID, match);
    return match;
}

+ (UIView *)findViewByText:(NSString *)text {
    if (text.length == 0) return nil;
    UIWindow *keyWin = [EnnioBootstrap keyWindow];
    UIView *match = walkByText(keyWin, text);
    if (!match) {
        match = walkAllWindows(^BOOL(UIView *v) {
            if ([v.accessibilityLabel isEqualToString:text]) return YES;
            if ([v.accessibilityValue isEqualToString:text]) return YES;
            if ([v isKindOfClass:UILabel.class] &&
                [((UILabel *)v).text isEqualToString:text])
                return YES;
            if ([v isKindOfClass:UIButton.class]) {
                NSString *title = [((UIButton *)v) titleForState:UIControlStateNormal];
                if ([title isEqualToString:text]) return YES;
            }
            return NO;
        });
    }
    return match;
}

+ (EnnioRect)windowRectFor:(UIView *)view {
    EnnioRect zero = {0, 0, 0, 0};
    if (!view || !view.window) return zero;
    CGRect r = [view.window convertRect:view.bounds fromView:view];
    EnnioRect out = {r.origin.x, r.origin.y, r.size.width, r.size.height};
    return out;
}

+ (BOOL)isOnScreen:(UIView *)view {
    if (!view) return NO;
    UIWindow *win = view.window;
    if (!win) return NO;
    if (view.hidden) return NO;
    if (view.alpha < 0.01) return NO;
    // Walk ancestor chain for hidden / alpha=0.
    for (UIView *p = view.superview; p && p != win; p = p.superview) {
        if (p.hidden || p.alpha < 0.01) return NO;
    }
    CGRect winRect = [win convertRect:view.bounds fromView:view];
    if (winRect.size.width <= 0 || winRect.size.height <= 0) return NO;
    return !CGRectIsEmpty(CGRectIntersection(winRect, win.bounds));
}

+ (void)invalidateCache {
    ensureCache();
    @synchronized(g_cache) {
        [g_cache removeAllObjects];
    }
}

@end
