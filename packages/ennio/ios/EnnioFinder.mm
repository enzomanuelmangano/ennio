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
#import "EnnioTestIDIndex.h"

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
static BOOL strContainsCI(NSString *haystack, NSString *needle) {
    if (!haystack.length || !needle.length) return NO;
    return [haystack rangeOfString:needle options:NSCaseInsensitiveSearch].location != NSNotFound;
}

// Maestro semantics: a text selector that contains regex
// metacharacters is treated as a regex pattern; otherwise plain
// substring. Used to match e.g. "Search for posts, users[,]? or feeds".
static BOOL looksLikeRegex(NSString *s) {
    if (s.length == 0) return NO;
    NSCharacterSet *meta = [NSCharacterSet characterSetWithCharactersInString:@"[]?*+(){}|^$\\"];
    return [s rangeOfCharacterFromSet:meta].location != NSNotFound;
}

static BOOL regexMatchCI(NSString *haystack, NSString *pattern) {
    if (!haystack.length || !pattern.length) return NO;
    NSError *err = nil;
    NSRegularExpression *re = [NSRegularExpression
        regularExpressionWithPattern:pattern
                             options:NSRegularExpressionCaseInsensitive
                               error:&err];
    if (err || !re) return NO;
    NSRange r = [re rangeOfFirstMatchInString:haystack options:0 range:NSMakeRange(0, haystack.length)];
    return r.location != NSNotFound;
}

static BOOL strContainsOrRegex(NSString *haystack, NSString *needle) {
    if (!haystack.length || !needle.length) return NO;
    if (looksLikeRegex(needle)) return regexMatchCI(haystack, needle);
    return strContainsCI(haystack, needle);
}

static BOOL strEqualsOrRegex(NSString *a, NSString *b) {
    if (!a || !b) return NO;
    if (looksLikeRegex(b)) return regexMatchCI(a, b);
    return [a caseInsensitiveCompare:b] == NSOrderedSame;
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
    if (strEqualsOrRegex(aLabel, text)) return 2;
    if (strEqualsOrRegex(aValue, text)) return 2;
    if (strEqualsOrRegex(primarySegment(aLabel), text)) return 2;
    if (strEqualsOrRegex(primarySegment(aValue), text)) return 2;
    if ([v isKindOfClass:UILabel.class]) {
        UILabel *lbl = (UILabel *)v;
        if (strEqualsOrRegex(lbl.text, text)) return 2;
    }
    if ([v isKindOfClass:UIButton.class]) {
        UIButton *btn = (UIButton *)v;
        NSString *title = [btn titleForState:UIControlStateNormal];
        if (strEqualsOrRegex(title, text)) return 2;
    }
    NSString *anyText = readAnyText(v);
    if (strEqualsOrRegex(anyText, text)) return 2;
    if (strContainsOrRegex(aLabel, text)) return 1;
    if (strContainsOrRegex(aValue, text)) return 1;
    if ([v isKindOfClass:UILabel.class]) {
        UILabel *lbl = (UILabel *)v;
        if (strContainsOrRegex(lbl.text, text)) return 1;
    }
    if ([v isKindOfClass:UIButton.class]) {
        UIButton *btn = (UIButton *)v;
        NSString *title = [btn titleForState:UIControlStateNormal];
        if (strContainsOrRegex(title, text)) return 1;
    }
    if (strContainsOrRegex(anyText, text)) return 1;
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

// Compute on-screen window-space area for a view. Used to break ties
// between multiple exact-match candidates — prefer the smaller view,
// which is almost always the inner element a human reader would tap
// (the UILabel "Description" rather than the wrapping TextField that
// also exposes "Description" as its accessibilityLabel).
static CGFloat viewWindowArea(UIView *v) {
    if (!v || !v.window) return CGFLOAT_MAX;
    CGRect r = [v.window convertRect:v.bounds fromView:v];
    if (r.size.width <= 0 || r.size.height <= 0) return CGFLOAT_MAX;
    return r.size.width * r.size.height;
}

static UIView *_Nullable bestFrom(NSArray<UIView *> *list) {
    if (list.count == 0) return nil;
    if (list.count == 1) return list.firstObject;
    // Tie-break by smallest area — Maestro-equivalent semantics where
    // text-targeted taps preferentially hit the narrowest matching
    // element rather than a wrapping container.
    UIView *best = nil;
    CGFloat bestArea = CGFLOAT_MAX;
    for (UIView *v in list) {
        CGFloat a = viewWindowArea(v);
        if (a < bestArea) {
            bestArea = a;
            best = v;
        }
    }
    return best ?: list.firstObject;
}

static UIView *_Nullable walkByText(UIView *root, NSString *text) {
    if (!root) return nil;
    NSMutableArray<UIView *> *matches = [NSMutableArray new];
    collectByText(root, text, matches);
    // Bucket candidates by selection-priority tier, then within each
    // tier pick the smallest. Without the size tie-break, an oversized
    // TextField wrapper whose a11y label equals "Description" outranks
    // the actual UILabel above it — a tap meant to defocus the field
    // re-focuses it instead, and the iOS edit-menu popover never
    // dismisses (blocks the next Save tap).
    NSMutableArray<UIView *> *exactOnscreenInteractive = [NSMutableArray new];
    NSMutableArray<UIView *> *exactOnscreen = [NSMutableArray new];
    NSMutableArray<UIView *> *anyOnscreenInteractive = [NSMutableArray new];
    NSMutableArray<UIView *> *anyOnscreen = [NSMutableArray new];
    for (UIView *v in matches) {
        BOOL onscreen = viewIsLikelyOnScreen(v);
        BOOL inter = isInteractive(v);
        int rank = viewTextMatchRank(v, text);
        if (rank == 2 && onscreen && inter) [exactOnscreenInteractive addObject:v];
        if (rank == 2 && onscreen) [exactOnscreen addObject:v];
        if (onscreen && inter) [anyOnscreenInteractive addObject:v];
        if (onscreen) [anyOnscreen addObject:v];
    }
    UIView *r = bestFrom(exactOnscreenInteractive);
    if (r) return r;
    r = bestFrom(exactOnscreen);
    if (r) return r;
    r = bestFrom(anyOnscreenInteractive);
    if (r) return r;
    r = bestFrom(anyOnscreen);
    if (r) return r;
    return matches.firstObject;
}

// Walk every UIWindow of every UIWindowScene — modal sheets and alerts
// live in their own UIWindow. Returns the first match across all.
//
// Drops the hidden filter: iOS 26 UISheetPresentationController hosts
// its content in a window with hidden=NO but isAttachedToScene=NO, and
// some keyboard / system-level windows report hidden=YES while
// still rendering their content (and crucially, while still being the
// only place a presented sheet's RN content lives).
//
// Also walks each window's rootViewController's presentation chain so
// modally-presented VCs whose .view is intentionally detached from
// the window's subview hierarchy (UIPresentationController owns the
// container view) are still searched.
static UIView *_Nullable walkAllWindows(BOOL (^matcher)(UIView *)) {
    NSMutableArray<UIWindow *> *windows = [NSMutableArray new];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            [windows addObject:w];
        }
    }
    // Helper: walk a view subtree + every presented VC chain rooted at
    // its rootViewController, returning the first matching view.
    UIView * (^walkSubtree)(UIView *) = ^UIView *(UIView *root) {
        NSMutableArray<UIView *> *stack = [NSMutableArray new];
        [stack addObject:root];
        while (stack.count) {
            UIView *v = stack.lastObject;
            [stack removeLastObject];
            if (matcher(v)) return v;
            for (UIView *sub in v.subviews) [stack addObject:sub];
        }
        return nil;
    };

    // Iterate top-down (last-presented first) so an alert beats a
    // covered view of the same testID.
    for (UIWindow *w in windows.reverseObjectEnumerator) {
        UIView *m = walkSubtree(w);
        if (m) return m;
        // Walk the rootVC's presented-VC chain. UISheetPresentationController
        // adds the sheet view to its container, which may not be a subview
        // of the window if iOS routes through a private host view.
        UIViewController *vc = w.rootViewController;
        while (vc) {
            UIView *vcView = vc.viewIfLoaded;
            if (vcView && vcView.superview == nil) {
                // Detached from window — still walkable.
                UIView *m2 = walkSubtree(vcView);
                if (m2) return m2;
            }
            vc = vc.presentedViewController;
        }
    }
    return nil;
}

@implementation EnnioFinder

+ (UIView *)findViewByTestID:(NSString *)testID {
    if (testID.length == 0) return nil;
    UIView *cached = cacheLookup(testID);
    if (cached) return cached;

    // Layer 1: O(1) hash lookup in the swizzle-populated testID index.
    // Catches every UIView whose accessibilityIdentifier has been set
    // since the dylib loaded — both Paper and Fabric apps because RN
    // propagates testID via setAccessibilityIdentifier in both archs.
    UIView *indexed = [EnnioTestIDIndex lookup:testID];
    if (indexed) {
        cacheStore(testID, indexed);
        return indexed;
    }

    // Layer 2 + 3: fall back to UIView tree walk. Catches host code
    // that assigns identifiers via runtime/KVC or before the swizzle
    // was installed (rare, but possible during dyld-attach race).
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
