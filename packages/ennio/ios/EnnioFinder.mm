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

// Try to read a view's visible text via any reasonable mechanism. RN's
// RCTText (rendered <Text> component) is a plain UIView subclass — not
// a UILabel — and exposes its content via `.attributedText` or `.text`.
// Use KVC with @try so missing keys don't crash; covers RCTText,
// RCTBaseText, RCTParagraphComponentView (Fabric), RCTTextView, and
// any other custom view that defines a `text` property.
static NSString *_Nullable readAnyText(UIView *v) {
    @try {
        id raw = [v valueForKey:@"text"];
        if ([raw isKindOfClass:NSString.class]) return (NSString *)raw;
        if ([raw isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)raw string];
    } @catch (...) {
    }
    @try {
        id raw = [v valueForKey:@"attributedText"];
        if ([raw isKindOfClass:NSString.class]) return (NSString *)raw;
        if ([raw isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)raw string];
    } @catch (...) {
    }
    return nil;
}

// Maestro semantics: `tapOn: text: 'X'` matches any view whose visible
// or accessible text CONTAINS X. Exact-equals fails when the
// surrounding text is decorated — e.g. `accessibilityLabel = "Cart"`
// becomes "Cart, tab, 3 of 5" for UITabBarItem children on iOS, and
// React Native sometimes attaches role/state suffixes.
//
// Match priority:
//   1. exact equality on accessibilityLabel / value / UILabel.text /
//      UIButton.title — preferred when there is a clean match
//   2. substring `containsString:` on the same fields — caught by the
//      collectByText caller via this same predicate
//   3. KVC text fallback for RCTText and friends (RN <Text> view)
// Returns 2 for exact match, 1 for substring match, 0 for no match.
// Both arms use case-insensitive comparison — Maestro's text matcher
// is case-insensitive and many apps re-case labels via text-transform
// (a UILabel rendering "ORDERS" still wants to match selector
// "Orders"). The two-tier rank prefers exact-match views over
// substring matches (a `tapOn text: "Profile"` should hit the tab,
// not the "Edit Profile" cell that substring-matches in a settings
// list).
static BOOL strEqualsCI(NSString *a, NSString *b) {
    if (!a || !b) return NO;
    return [a caseInsensitiveCompare:b] == NSOrderedSame;
}

static BOOL strContainsCI(NSString *haystack, NSString *needle) {
    if (!haystack.length || !needle.length) return NO;
    return [haystack rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound;
}

// UIKit decorates tab-bar items and similar controls with comma-
// separated metadata in their accessibilityLabel:
//   "Profile, Tab, 4 of 5, selected"
// Strip the trailing metadata so the first segment ("Profile") can be
// compared as an exact match — otherwise the tab-bar item loses to a
// "Edit Profile" cell that substring-matches "Profile" on a settings
// screen below it in the hierarchy.
static NSString *primarySegment(NSString *s) {
    if (!s.length) return s;
    NSRange r = [s rangeOfString:@", "];
    if (r.location == NSNotFound) return s;
    return [s substringToIndex:r.location];
}

static int viewTextMatchRank(UIView *v, NSString *text) {
    NSString *aLabel = v.accessibilityLabel;
    NSString *aValue = v.accessibilityValue;
    if (strEqualsCI(aLabel, text)) return 2;
    if (strEqualsCI(aValue, text)) return 2;
    if (strEqualsCI(primarySegment(aLabel), text)) return 2;
    if (strEqualsCI(primarySegment(aValue), text)) return 2;
    if ([v isKindOfClass:UILabel.class]) {
        UILabel *lbl = (UILabel *)v;
        if (strEqualsCI(lbl.text, text)) return 2;
    }
    if ([v isKindOfClass:UIButton.class]) {
        UIButton *btn = (UIButton *)v;
        NSString *title = [btn titleForState:UIControlStateNormal];
        if (strEqualsCI(title, text)) return 2;
    }
    NSString *anyText = readAnyText(v);
    if (strEqualsCI(anyText, text)) return 2;
    if (strContainsCI(aLabel, text)) return 1;
    if (strContainsCI(aValue, text)) return 1;
    if ([v isKindOfClass:UILabel.class]) {
        UILabel *lbl = (UILabel *)v;
        if (strContainsCI(lbl.text, text)) return 1;
    }
    if ([v isKindOfClass:UIButton.class]) {
        UIButton *btn = (UIButton *)v;
        NSString *title = [btn titleForState:UIControlStateNormal];
        if (strContainsCI(title, text)) return 1;
    }
    if (strContainsCI(anyText, text)) return 1;
    return 0;
}

static BOOL viewMatchesText(UIView *v, NSString *text) {
    return viewTextMatchRank(v, text) > 0;
}

// Collect every matching view (preorder DFS). Used to pick the best
// candidate — interactive views beat plain text labels.
static void collectByText(UIView *root, NSString *text, NSMutableArray<UIView *> *out) {
    if (!root) return;
    if (viewMatchesText(root, text)) [out addObject:root];
    for (UIView *sub in root.subviews) collectByText(sub, text, out);
}

// Coarse on-screen check used by walkByText to skip transient/hidden
// view-tree clones (UINavigationBar pre-renders 2 copies of every
// title during transitions; only one is actually on screen).
static BOOL viewIsLikelyOnScreen(UIView *v) {
    if (!v) return NO;
    if (!v.window) return NO;
    if (v.hidden) return NO;
    if (v.alpha < 0.05) return NO;
    for (UIView *p = v.superview; p; p = p.superview) {
        if (p.hidden) return NO;
        if (p.alpha < 0.05) return NO;
    }
    CGRect winRect = [v.window convertRect:v.bounds fromView:v];
    if (winRect.size.width <= 0 || winRect.size.height <= 0) return NO;
    return !CGRectIsEmpty(CGRectIntersection(winRect, v.window.bounds));
}

static UIView *_Nullable walkByText(UIView *root, NSString *text) {
    if (!root) return nil;
    NSMutableArray<UIView *> *matches = [NSMutableArray new];
    collectByText(root, text, matches);
    // Selection priority (most-specific wins):
    //   1. exact match + on-screen + interactive
    //   2. exact match + on-screen
    //   3. substring match + on-screen + interactive
    //   4. substring match + on-screen
    //   5. any match, even off-screen (last-resort, e.g. transitioning)
    for (UIView *v in matches) {
        if (viewTextMatchRank(v, text) == 2 && viewIsLikelyOnScreen(v) && isInteractive(v)) return v;
    }
    for (UIView *v in matches) {
        if (viewTextMatchRank(v, text) == 2 && viewIsLikelyOnScreen(v)) return v;
    }
    for (UIView *v in matches) {
        if (viewIsLikelyOnScreen(v) && isInteractive(v)) return v;
    }
    for (UIView *v in matches) {
        if (viewIsLikelyOnScreen(v)) return v;
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
