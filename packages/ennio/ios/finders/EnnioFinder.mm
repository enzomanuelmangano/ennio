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
static BOOL isInsideNavigationBar(UIView *v) {
    for (UIView *a = v.superview; a; a = a.superview) {
        if ([a isKindOfClass:UINavigationBar.class]) return YES;
    }
    return NO;
}

static BOOL isInteractive(UIView *v) {
    if (!v) return NO;
    // Views inside UINavigationBar are not user-tap targets. iOS 26
    // wraps the title in UINavigationBarTitleControl (a UIControl) and
    // private subviews carry GRs/traits for scroll-to-top, large-title
    // collapse etc. Suppress ALL interactive signals except UIButton —
    // actual bar-button items (Back, right items) are UIButton
    // subclasses and must stay interactive.
    BOOL inNavBar = isInsideNavigationBar(v);
    UIView *cur = v;
    for (int hop = 0; hop < 4 && cur; hop++, cur = cur.superview) {
        if (cur.userInteractionEnabled) {
            if ([cur isKindOfClass:UIButton.class]) return YES;
            if (!inNavBar && [cur isKindOfClass:UIControl.class]) return YES;
            if (!inNavBar) {
                for (UIGestureRecognizer *g in cur.gestureRecognizers) {
                    if (g.isEnabled) return YES;
                }
                UIAccessibilityTraits t = cur.accessibilityTraits;
                if ((t & UIAccessibilityTraitButton) || (t & UIAccessibilityTraitLink)) return YES;
            }
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

// Whether the CURRENT text find treats its selector as a regex. The CLI is the
// single source of truth — it computes isRegexText once and passes the `regex`
// flag on find_by_text / find_ax_by_text; the finder used to RE-derive this
// with its own metachar scan (looksLikeRegex), a second definition that could
// silently diverge from the CLI's. Set once at the find entry (single-threaded,
// main-thread finder), read by the matchers below.
static BOOL g_textSelectorIsRegex = NO;

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

// Literal match is primary; the regex interpretation is a fallback. A
// selector whose metacharacters are actually literal — e.g.
// "Change position (left)", where "(left)" reads as a regex group but the
// on-screen label has real parentheses — resolves by its literal text,
// while a genuine pattern ("users[,]? or feeds") still matches via regex.
static BOOL strContainsOrRegex(NSString *haystack, NSString *needle) {
    if (!haystack.length || !needle.length) return NO;
    if (strContainsCI(haystack, needle)) return YES;
    if (g_textSelectorIsRegex) return regexMatchCI(haystack, needle);
    return NO;
}

static BOOL strEqualsOrRegex(NSString *a, NSString *b) {
    if (!a || !b) return NO;
    if ([a caseInsensitiveCompare:b] == NSOrderedSame) return YES;
    if (g_textSelectorIsRegex) return regexMatchCI(a, b);
    return NO;
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

// Topmost-VC helpers — duplicated from EnnioTestIDIndex.mm because
// they're file-local statics there and we want the same semantics for
// text-based finds. When a modal sheet is up, find_by_text must not
// return a view that lives in the underlying scene's VC subtree
// (e.g. the bottom tab bar's "Search" button hidden behind a
// BottomSheet "Add people to list" modal — its label still matches
// but its host VC is the underlying tab controller, not the sheet).
static UIViewController *_Nullable finderHostingVC(UIView *v) {
    UIResponder *r = v;
    while (r) {
        r = r.nextResponder;
        if ([r isKindOfClass:UIViewController.class]) return (UIViewController *)r;
    }
    return nil;
}

static UIViewController *_Nullable finderTopmostPresentedVC(void) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        UIWindowScene *ws = (UIWindowScene *)scene;
        UIWindow *keyWin = nil;
        for (UIWindow *w in ws.windows) {
            if (w.isKeyWindow) { keyWin = w; break; }
        }
        if (!keyWin) continue;
        UIViewController *vc = keyWin.rootViewController;
        while (vc.presentedViewController && !vc.presentedViewController.isBeingDismissed) {
            vc = vc.presentedViewController;
        }
        return vc;
    }
    return nil;
}

static BOOL finderVCInTopmost(UIViewController *vc, UIViewController *topmost) {
    if (!vc || !topmost) return YES; // fail-open
    if (vc == topmost) return YES;
    UIView *topView = topmost.view;
    UIView *probe = vc.view;
    while (probe) {
        if (probe == topView) return YES;
        probe = probe.superview;
    }
    return NO;
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

// When `walkByText` lands on a UILabel / RCTText whose parent is the
// real tappable container (RN Pressable, RNGH GestureHandlerButton,
// expo-router tab-bar item with a Liquid-Glass blur backdrop), tapping
// the label rect doesn't hit-test inside the button's hit slop AND
// some glass-effect host views don't forward touches up the responder
// chain — the press never fires. Walk up to the nearest interactive
// ancestor (Pressable, UIControl, view with a Tap recognizer, or
// view with UIAccessibilityTraitButton/Link) and return THAT view's
// rect instead. Falls back to the original view when no ancestor
// qualifies.
static UIView *_Nullable promoteToInteractiveAncestor(UIView *v) {
    if (!v) return nil;
    // The matched view itself already qualifies — return as-is.
    if (isInteractive(v) &&
        ![v isKindOfClass:UILabel.class] &&
        ![NSStringFromClass([v class]) hasPrefix:@"RCTText"] &&
        ![NSStringFromClass([v class]) hasPrefix:@"RCTParagraph"]) {
        return v;
    }
    // Cap promotion by area: don't return an ancestor whose window-
    // space area is more than 25× the matched view's area. Without
    // a cap, an outer drag-gesture container (e.g. a bottom-sheet's
    // pan-to-dismiss handler wrapping all rows) wins over the per-row
    // Pressable, and the tap lands on whatever row happens to
    // intersect the cached center. The 25× threshold allows realistic
    // label→button promotions (iOS 26 liquid-glass tab labels are
    // ~10× smaller than their interactive tab button; bsky's Link
    // wrapping a Text node is ~15× larger) while still rejecting
    // whole-screen drag containers (typically 60×+ vs an inner row).
    CGFloat baseArea = viewWindowArea(v);
    CGFloat areaCap = (baseArea > 0 && baseArea < CGFLOAT_MAX) ? baseArea * 25.0 : CGFLOAT_MAX;
    UIView *cur = v.superview;
    for (int hop = 0; hop < 6 && cur; hop++, cur = cur.superview) {
        if (!cur.userInteractionEnabled) continue;
        // A scroll view is never THE tappable control — it scrolls. Its
        // private touch recognizers (UIScrollViewDelayedTouchesBegan…,
        // knob long-press) are not "this is a button" signals, and
        // promoting to one re-centers the tap on the container (bsky
        // home pager tab bar). The real Pressable, when present, sits
        // at an earlier hop and wins before we ever reach the scroller.
        if ([cur isKindOfClass:UIScrollView.class]) continue;
        if (viewWindowArea(cur) > areaCap) return v;
        if ([cur isKindOfClass:UISegmentedControl.class]) return v;
        if ([cur isKindOfClass:UIControl.class]) return cur;
        if ([cur isKindOfClass:UIButton.class]) return cur;
        for (UIGestureRecognizer *g in cur.gestureRecognizers) {
            if (!g.isEnabled) continue;
            // Pan/pinch recognizers mean "this container scrolls/zooms",
            // not "this is the tappable control". Promoting to a scroll
            // view re-centers the tap on the CONTAINER — bsky's home
            // pager: "Feeds ✨" label promoted to the full-width
            // RCTCustomScrollView tab bar, tap fired at x=center on the
            // divider between the two tabs and the pager never switched.
            if ([g isKindOfClass:UIPanGestureRecognizer.class]) continue;
            if ([g isKindOfClass:UIPinchGestureRecognizer.class]) continue;
            return cur;
        }
        UIAccessibilityTraits t = cur.accessibilityTraits;
        if ((t & UIAccessibilityTraitButton) || (t & UIAccessibilityTraitLink)) return cur;
        NSString *cls = NSStringFromClass([cur class]);
        if ([cls hasSuffix:@"GestureHandlerButton"]) return cur;
    }
    return v;
}

static UIView *_Nullable walkByTextEx(UIView *root, NSString *text, BOOL relaxed);

static UIView *_Nullable walkByText(UIView *root, NSString *text) {
    return walkByTextEx(root, text, NO);
}

static UIView *_Nullable walkByTextEx(UIView *root, NSString *text, BOOL relaxed) {
    if (!root) return nil;
    NSMutableArray<UIView *> *matches = [NSMutableArray new];
    collectByText(root, text, matches);
    UIViewController *topmost = relaxed ? nil : finderTopmostPresentedVC();
    // Bucket candidates by selection-priority tier, then within each
    // tier pick the smallest. Without the size tie-break, an oversized
    // TextField wrapper whose a11y label equals "Description" outranks
    // the actual UILabel above it — a tap meant to defocus the field
    // re-focuses it instead, and the iOS edit-menu popover never
    // dismisses (blocks the next Save tap).
    //
    // Adds a topmost-VC filter: when a modal is presented, only
    // accept candidates whose host VC is the topmost. Without this,
    // a tab bar button labelled "Search" hidden behind a
    // BottomSheet outranks the sheet's search input field — the tap
    // fires at the bottom tab bar coord, lands on the sheet backdrop
    // at that point, and dismisses the sheet.
    NSMutableArray<UIView *> *exactOnscreenInteractive = [NSMutableArray new];
    NSMutableArray<UIView *> *exactOnscreen = [NSMutableArray new];
    NSMutableArray<UIView *> *anyOnscreenInteractive = [NSMutableArray new];
    NSMutableArray<UIView *> *anyOnscreen = [NSMutableArray new];
    for (UIView *v in matches) {
        BOOL onscreen = viewIsLikelyOnScreen(v);
        BOOL inter = isInteractive(v);
        BOOL inTop = finderVCInTopmost(finderHostingVC(v), topmost);
        if (!inTop) continue;
        int rank = viewTextMatchRank(v, text);
        if (rank == 2 && onscreen && inter) [exactOnscreenInteractive addObject:v];
        if (rank == 2 && onscreen) [exactOnscreen addObject:v];
        if (onscreen && inter) [anyOnscreenInteractive addObject:v];
        if (onscreen) [anyOnscreen addObject:v];
    }
    UIView *r = bestFrom(exactOnscreenInteractive);
    if (r) return promoteToInteractiveAncestor(r);
    r = bestFrom(exactOnscreen);
    if (r) return promoteToInteractiveAncestor(r);
    r = bestFrom(anyOnscreenInteractive);
    if (r) return promoteToInteractiveAncestor(r);
    r = bestFrom(anyOnscreen);
    if (r) return promoteToInteractiveAncestor(r);
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

// Walk UIAccessibility's element tree, not just UIView subviews.
// iOS exposes UIAccessibilityElement proxies for content rendered by
// out-of-process view services (PHPickerViewController, UIDocument-
// PickerViewController, the share sheet) — the proxies live on
// UIRemoteView instances inside our process and carry the remote
// content's accessibilityLabel / accessibilityFrame as if they were
// regular UIKit elements. A subview-only walk misses them; this walk
// matches Maestro / XCUITest in coverage without spawning a runner
// process or invoking an external tool for discovery.
//
// Walks both accessibilityElements (when overridden, e.g. UILabel
// returns the View itself) and accessibilityElementAtIndex: (used by
// UIAccessibilityContainer-conforming proxies). Falls through to
// regular subview traversal for everything else.
static BOOL axMatchesText(id element, NSString *text) {
    if (!element || !text.length) return NO;
    NSString *aLabel = nil;
    NSString *aValue = nil;
    if ([element respondsToSelector:@selector(accessibilityLabel)]) {
        aLabel = [element accessibilityLabel];
    }
    if ([element respondsToSelector:@selector(accessibilityValue)]) {
        aValue = [element accessibilityValue];
    }
    if (strEqualsOrRegex(aLabel, text)) return YES;
    if (strEqualsOrRegex(aValue, text)) return YES;
    if (strEqualsOrRegex(primarySegment(aLabel), text)) return YES;
    if (strEqualsOrRegex(primarySegment(aValue), text)) return YES;
    if (strContainsOrRegex(aLabel, text)) return YES;
    if (strContainsOrRegex(aValue, text)) return YES;
    return NO;
}

static CGRect axFrameOf(id element) {
    if ([element respondsToSelector:@selector(accessibilityFrame)]) {
        return [element accessibilityFrame];
    }
    return CGRectZero;
}

typedef struct { CGRect rect; int rank; CGFloat area; BOOL found; } AxMatch;

static void collectAxByText(id root,
                            NSString *text,
                            NSMutableArray *outRects,
                            NSMutableSet *visited) {
    if (!root) return;
    NSValue *idVal = [NSValue valueWithNonretainedObject:root];
    if ([visited containsObject:idVal]) return;
    [visited addObject:idVal];

    if (axMatchesText(root, text)) {
        CGRect r = axFrameOf(root);
        if (!CGRectIsEmpty(r)) {
            // Filter off-screen elements. AX walker exposes cached /
            // recycled views (e.g. RN-Navigation's off-screen tab
            // cache) at synthetic coords like x = -300. Tests would
            // false-match these as "visible" — assertNotVisible would
            // fail because the AX element persists invisible to the
            // user. Bound rect to the key window's bounds.
            UIWindow *keyWin = nil;
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class]) continue;
                for (UIWindow *w in ((UIWindowScene *)scene).windows) {
                    if (w.isKeyWindow) { keyWin = w; break; }
                }
                if (keyWin) break;
            }
            CGRect bounds = keyWin ? keyWin.bounds : CGRectMake(0, 0, 9999, 9999);
            if (!CGRectIsEmpty(CGRectIntersection(r, bounds))) {
                [outRects addObject:[NSValue valueWithCGRect:r]];
            }
        }
    }

    // Walk accessibilityElements (UIView override path + UIRemoteView
    // proxies). When overridden, this REPLACES subviews as the AX
    // children — we still walk both to maximise coverage.
    if ([root respondsToSelector:@selector(accessibilityElements)]) {
        id elems = [root accessibilityElements];
        if ([elems isKindOfClass:NSArray.class]) {
            for (id e in (NSArray *)elems) {
                collectAxByText(e, text, outRects, visited);
            }
        }
    }
    // Walk accessibilityElementAtIndex: — used by
    // UIAccessibilityContainer-conforming objects (most UIRemoteView
    // proxies) that don't expose accessibilityElements directly.
    if ([root respondsToSelector:@selector(accessibilityElementCount)] &&
        [root respondsToSelector:@selector(accessibilityElementAtIndex:)]) {
        NSInteger n = [root accessibilityElementCount];
        // Cap walk depth at 1024 per container — sane bound against
        // pathological proxies that return huge counts.
        if (n > 0 && n < 4096) {
            for (NSInteger i = 0; i < n; i++) {
                id sub = [root accessibilityElementAtIndex:i];
                if (sub) collectAxByText(sub, text, outRects, visited);
            }
        }
    }
    // Subview fallback for plain UIView trees that don't override
    // either of the above (the common case).
    if ([root isKindOfClass:UIView.class]) {
        for (UIView *sub in [(UIView *)root subviews]) {
            collectAxByText(sub, text, outRects, visited);
        }
    }
}

// Find the topmost presented view controller, walking the
// presentation chain across every UIWindow + scene. Used to detect
// known cross-process VCs (PHPicker, share sheet, document picker)
// whose contents we can't introspect but whose presence we can
// confirm — and whose well-known label set we can synthesise rects
// for, since the in-process VC class identifies the chrome layout.
// Returns every VC in every window's presentation chain. Used by
// the cross-process synthesiser to find a recognisable known-host
// VC anywhere in the chain — the "top" alone misses cases where
// iOS layers an internal helper VC above the recognisable picker
// (e.g. ExpoScreenOrientation injects a wrapper above PHPicker).
static NSArray<UIViewController *> *allPresentedViewControllers(void) {
    NSMutableArray<UIViewController *> *all = [NSMutableArray new];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            UIViewController *vc = w.rootViewController;
            while (vc) {
                [all addObject:vc];
                vc = vc.presentedViewController;
            }
        }
    }
    return all;
}

// Cross-process VC fallback. PHPickerViewController (and friends) is
// just a UIRemoteView host on our side — its labels live in the
// remote process. But the host UIViewController's class identifies
// it, and its chrome layout is stable across iOS versions. When
// we're told to assertVisible / tap a known label on one of these,
// return a synthesised rect computed from the host VC's view frame.
//
// Returns YES only when the asserted text is a known label of the
// detected VC. Coords are best-effort and only used as a positive
// answer to "is this label visible?" — Maestro-style point taps
// (the YAML's `point: "50%,22%"`) still cover the actual photo grid.
static BOOL synthAxRectForCrossProcess(NSString *text, EnnioRect *out) {
    NSArray<UIViewController *> *all = allPresentedViewControllers();
    if (all.count == 0) return NO;
    UIViewController *phPicker = nil;
    UIViewController *shareSheet = nil;
    for (UIViewController *vc in all) {
        NSString *cls = NSStringFromClass([vc class]);
        if (!phPicker && ([cls containsString:@"PHPicker"] ||
                           [cls containsString:@"PhotoPicker"] ||
                           [cls containsString:@"PHImagePicker"])) {
            phPicker = vc;
        }
        if (!shareSheet && ([cls containsString:@"UIActivityViewController"] ||
                             [cls containsString:@"SLComposeServiceViewController"])) {
            shareSheet = vc;
        }
    }
    UIViewController *vc = phPicker ?: shareSheet;
    if (!vc) return NO;
    UIView *vcView = vc.viewIfLoaded;
    if (!vcView || !vcView.window) return NO;
    CGRect winF = [vcView.window convertRect:vcView.bounds fromView:vcView];
    if (CGRectIsEmpty(winF)) return NO;
    NSString *lc = text.lowercaseString;

    BOOL isPhPicker = (vc == phPicker);
    if (isPhPicker) {
        if ([lc isEqualToString:@"photos"] ||
            [lc isEqualToString:@"collections"] ||
            [lc isEqualToString:@"done"] ||
            [lc isEqualToString:@"cancel"] ||
            [lc isEqualToString:@"add"]) {
            // Header tabs (Photos / Collections) — top quarter.
            // Done / Cancel / Add at top corners.
            CGFloat hY = winF.origin.y + winF.size.height * 0.10;
            CGFloat hH = winF.size.height * 0.06;
            CGFloat cx = winF.origin.x + winF.size.width * 0.5;
            if ([lc isEqualToString:@"done"] || [lc isEqualToString:@"add"]) {
                out->x = winF.origin.x + winF.size.width * 0.85;
                out->y = hY;
                out->w = winF.size.width * 0.12;
                out->h = hH;
            } else if ([lc isEqualToString:@"cancel"]) {
                out->x = winF.origin.x + winF.size.width * 0.03;
                out->y = hY;
                out->w = winF.size.width * 0.10;
                out->h = hH;
            } else {
                // Photos / Collections — segmented header.
                out->x = cx - winF.size.width * 0.10;
                out->y = hY;
                out->w = winF.size.width * 0.20;
                out->h = hH;
            }
            return YES;
        }
    }
    // Share sheet / activity controller — "Done", "Cancel", "Save"
    // tend to be the only addressable labels from outside.
    BOOL isShareSheet = (vc == shareSheet);
    if (isShareSheet) {
        if ([lc isEqualToString:@"done"] || [lc isEqualToString:@"cancel"]) {
            out->x = winF.origin.x + winF.size.width * 0.85;
            out->y = winF.origin.y + winF.size.height * 0.05;
            out->w = winF.size.width * 0.12;
            out->h = 44;
            return YES;
        }
    }
    return NO;
}

+ (EnnioRect)findAxRectByText:(NSString *)text found:(BOOL *)found {
    return [self findAxRectByText:text found:found regex:NO];
}

+ (EnnioRect)findAxRectByText:(NSString *)text found:(BOOL *)found regex:(BOOL)regex {
    g_textSelectorIsRegex = regex;
    EnnioRect zero = {0, 0, 0, 0};
    if (found) *found = NO;
    if (text.length == 0) return zero;
    NSMutableArray<NSValue *> *rects = [NSMutableArray new];
    NSMutableSet *visited = [NSMutableSet new];
    // Walk every window's root + presented-VC chain. UIAlertController
    // and presented sheets live in their own window; PHPicker's
    // UIRemoteView lives in the presenting view controller.
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            collectAxByText(w, text, rects, visited);
            UIViewController *vc = w.rootViewController;
            while (vc) {
                UIView *vv = vc.viewIfLoaded;
                if (vv && !vv.superview) {
                    collectAxByText(vv, text, rects, visited);
                }
                vc = vc.presentedViewController;
            }
        }
    }
    if (rects.count == 0) {
        // Last resort: cross-process VC chrome geometry synth.
        // PHPicker / share sheet / doc picker — known-class hosts
        // whose chrome labels live in a remote process. We can't
        // walk into them, but the host VC class lets us compute
        // approximate rects for their well-known buttons (Done,
        // Photos, Cancel, etc.). Tried AFTER in-process walks fail
        // so we don't shadow a real in-process button (e.g. a
        // cropper VC presented above PHPicker has its own real
        // Done in our process — we should find that first).
        EnnioRect synth = {0, 0, 0, 0};
        if (synthAxRectForCrossProcess(text, &synth)) {
            if (found) *found = YES;
            return synth;
        }
        return zero;
    }
    // Prefer smaller-area rect (the leaf, not a wrapping container).
    CGRect best = [rects.firstObject CGRectValue];
    CGFloat bestArea = best.size.width * best.size.height;
    for (NSValue *v in rects) {
        CGRect r = [v CGRectValue];
        if (CGRectIsEmpty(r)) continue;
        CGFloat a = r.size.width * r.size.height;
        if (a > 0 && a < bestArea) {
            best = r;
            bestArea = a;
        }
    }
    if (CGRectIsEmpty(best)) return zero;
    EnnioRect out = { best.origin.x, best.origin.y, best.size.width, best.size.height };
    if (found) *found = YES;
    return out;
}

+ (UIView *)findViewByText:(NSString *)text {
    return [self findViewByText:text relaxed:NO regex:NO];
}

+ (UIView *)findViewByText:(NSString *)text relaxed:(BOOL)relaxed {
    return [self findViewByText:text relaxed:relaxed regex:NO];
}

+ (UIView *)findViewByText:(NSString *)text relaxed:(BOOL)relaxed regex:(BOOL)regex {
    // Set the selector mode for the matchers, from the CLI's authoritative flag.
    g_textSelectorIsRegex = regex;
    if (text.length == 0) return nil;
    UIWindow *keyWin = [EnnioBootstrap keyWindow];
    UIView *match = walkByTextEx(keyWin, text, relaxed);
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

+ (BOOL)isBehindTopmostPresentation:(UIView *)view {
    if (!view) return NO;
    UIViewController *host = finderHostingVC(view);
    UIViewController *top = finderTopmostPresentedVC();
    if (!host || !top) return NO; // fail-open: can't tell
    return !finderVCInTopmost(host, top);
}

+ (BOOL)isViewTransitioning:(UIView *)view {
    if (!view) return NO;
    UIViewController *vc = finderHostingVC(view);
    for (; vc; vc = vc.parentViewController) {
        if (vc.isBeingDismissed || vc.isBeingPresented) return YES;
        if (vc.isMovingFromParentViewController || vc.isMovingToParentViewController) return YES;
    }
    return NO;
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
