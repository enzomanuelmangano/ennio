//
// EnnioTestIDIndex.mm — see header for design.
//

#import "EnnioTestIDIndex.h"

#import <objc/runtime.h>
#import <objc/message.h>
#import <os/lock.h>

// testID → NSHashTable<UIView *> (weak refs). Multiple views may
// transiently share a testID during RN re-mount; we keep all and
// pick the last live one on lookup.
static NSMutableDictionary<NSString *, NSHashTable<UIView *> *> *g_index;
static os_unfair_lock g_lock = OS_UNFAIR_LOCK_INIT;
// Condition broadcasted on every registration so waitFor can wake
// event-driven (paired with EnnioSettle's universal commit signal —
// both broadcast on commit ticks, since the renderer propagates testID
// via accessibilityIdentifier during the same mount that moves the
// frame-hash).
static NSCondition *g_cond;
static IMP g_origSetAID = NULL;
static BOOL g_attached = NO;

static void ensureInit(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_index = [NSMutableDictionary new];
        g_cond = [NSCondition new];
    });
}

static void registerView(UIView *view, NSString *testID) {
    if (!view || !testID.length) return;
    ensureInit();
    os_unfair_lock_lock(&g_lock);
    NSHashTable<UIView *> *bucket = g_index[testID];
    if (!bucket) {
        bucket = [NSHashTable weakObjectsHashTable];
        g_index[testID] = bucket;
    }
    [bucket addObject:view];
    os_unfair_lock_unlock(&g_lock);
    // Broadcast outside the lock so waiters don't immediately
    // contend the unfair_lock we still hold (NSCondition broadcast
    // is its own lock).
    [g_cond lock];
    [g_cond broadcast];
    [g_cond unlock];
}

// Peek into the index. Returns first live view whose
// accessibilityIdentifier still matches AND that is attached to a
// window. Lock-held briefly; no main-thread bounce.
static UIView *_Nullable peekLive(NSString *testID) {
    if (!testID.length) return nil;
    ensureInit();
    UIView *result = nil;
    os_unfair_lock_lock(&g_lock);
    NSHashTable<UIView *> *bucket = g_index[testID];
    if (bucket) {
        // NSHashTable iteration order is insertion-ish; later
        // registrations beat earlier ones. Pick the last live.
        for (UIView *v in bucket) {
            if (!v) continue;
            if (!v.window) continue;
            // Re-validate the identifier — RN sometimes clears it
            // and the table still holds the stale entry.
            if (![v.accessibilityIdentifier isEqualToString:testID]) continue;
            result = v;
        }
    }
    os_unfair_lock_unlock(&g_lock);
    return result;
}

// Swizzled setAccessibilityIdentifier:. Chains to the original, then
// registers the (testID, view) pair. nil/empty testID is a no-op on
// the index — UIKit accepts nil to clear the identifier and that's
// not interesting to us.
static void swizzledSetAID(id self, SEL _cmd, NSString *testID) {
    using FnT = void (*)(id, SEL, NSString *);
    if (g_origSetAID) {
        ((FnT)g_origSetAID)(self, _cmd, testID);
    }
    if (testID.length && [self isKindOfClass:UIView.class]) {
        registerView((UIView *)self, testID);
    }
}

@implementation EnnioTestIDIndex

+ (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        ensureInit();
        SEL sel = @selector(setAccessibilityIdentifier:);
        Method m = class_getInstanceMethod(UIView.class, sel);
        if (!m) {
            NSLog(@"[Ennio] testID index: setAccessibilityIdentifier: not found");
            return;
        }
        g_origSetAID = method_getImplementation(m);
        method_setImplementation(m, (IMP)swizzledSetAID);
        g_attached = YES;
        NSLog(@"[Ennio] testID index: swizzle installed (os_unfair_lock)");
    });
}

+ (UIView *)lookup:(NSString *)testID {
    return peekLive(testID);
}

// All live views matching testID, sorted by window-space Y (top-to-
// bottom), then X (left-to-right). Lets Maestro's `index: N` selector
// pick the Nth visible match — needed for postDropdownBtn / replyBtn
// flows that operate on a specific feed item.
// Walk a view's responder chain to find its hosting UIViewController.
// UIKit's -[UIView _viewControllerForAncestor] is private; the public
// equivalent is the responder chain — UIViewController is a responder
// inserted between its view and the view's parent view.
static UIViewController *_Nullable hostingVC(UIView *v) {
    UIResponder *r = v;
    while (r) {
        r = r.nextResponder;
        if ([r isKindOfClass:UIViewController.class]) return (UIViewController *)r;
    }
    return nil;
}

// Walk down the presentedViewController chain from a window's root and
// return the deepest non-dismissing VC — that's the modal currently
// receiving touches. Returns nil if no scene/window is reachable.
static UIViewController *_Nullable topmostPresentedVC(void) {
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

// True iff `vc` is the topmost VC, or is contained inside it (its view
// is a descendant of the topmost's view). Container VCs (UINavigation,
// UITabBar, UIPageViewController) all wire their child VCs' views as
// subviews of their own, so this check correctly accepts a nested
// search results screen while a sheet is presented above it.
static BOOL vcIsInTopmost(UIViewController *vc, UIViewController *topmost) {
    if (!vc || !topmost) return YES; // fail-open if we couldn't resolve
    if (vc == topmost) return YES;
    UIView *topView = topmost.view;
    UIView *probe = vc.view;
    while (probe) {
        if (probe == topView) return YES;
        probe = probe.superview;
    }
    return NO;
}

+ (NSArray<UIView *> *)lookupAll:(NSString *)testID {
    if (!testID.length) return @[];
    ensureInit();
    NSMutableArray<UIView *> *out = [NSMutableArray array];
    UIViewController *topmost = topmostPresentedVC();
    os_unfair_lock_lock(&g_lock);
    NSHashTable<UIView *> *bucket = g_index[testID];
    if (bucket) {
        for (UIView *v in bucket) {
            if (!v || !v.window) continue;
            if (![v.accessibilityIdentifier isEqualToString:testID]) continue;
            // Filter on-screen: RN VirtualizedList recycles cells —
            // off-screen cells stay mounted at synthetic positions
            // (e.g. y = -10000) so their reuse is cheap. Including
            // them in the sorted list breaks `index: N` semantics
            // because the topmost-by-Y entry is a recycled cell,
            // not the visually-first item. A simple frame-intersect
            // with the window bounds is enough to drop them.
            UIWindow *win = v.window;
            CGRect winRect = [win convertRect:v.bounds fromView:v];
            if (CGRectIsEmpty(CGRectIntersection(winRect, win.bounds))) continue;
            // Tighter on-screen check: a view with its center outside
            // the window is not tappable, even if the bounding box
            // technically clips into the window. Bluesky's edit profile
            // page sometimes keeps a stale profileHeaderEditProfileButton
            // mounted at y ≈ -3 after the second save cycle (RN's
            // remount path), and the wider intersection check picks it
            // up as "topmost" by Y. Tap fires at y=-3, lands in the
            // status-bar inset, no gesture armed there.
            CGPoint center = CGPointMake(CGRectGetMidX(winRect), CGRectGetMidY(winRect));
            if (!CGRectContainsPoint(win.bounds, center)) continue;
            if (v.hidden || v.alpha < 0.05) continue;
            // Filter to topmost presented VC: when a modal sheet is up
            // (Bluesky composer, action sheets, settings modals), the
            // underlying scroll-view children stay mounted with valid
            // window rects but are covered by the modal. Touches can't
            // reach them, so they must not be candidates. Walks the
            // hosting VC's view up to topmost.view; accepts container
            // VCs (navigation, page-view) whose children render inside
            // the topmost. Fail-open when either resolution fails so
            // we never block normal taps.
            UIViewController *vvc = hostingVC(v);
            if (!vcIsInTopmost(vvc, topmost)) continue;
            [out addObject:v];
        }
    }
    os_unfair_lock_unlock(&g_lock);
    [out sortUsingComparator:^NSComparisonResult(UIView *a, UIView *b) {
        UIWindow *wa = a.window;
        UIWindow *wb = b.window;
        CGRect ra = wa ? [wa convertRect:a.bounds fromView:a] : a.frame;
        CGRect rb = wb ? [wb convertRect:b.bounds fromView:b] : b.frame;
        if (ra.origin.y < rb.origin.y) return NSOrderedAscending;
        if (ra.origin.y > rb.origin.y) return NSOrderedDescending;
        if (ra.origin.x < rb.origin.x) return NSOrderedAscending;
        if (ra.origin.x > rb.origin.x) return NSOrderedDescending;
        return NSOrderedSame;
    }];
    return out;
}

+ (UIView *)waitFor:(NSString *)testID maxMs:(uint32_t)maxMs {
    UIView *hit = peekLive(testID);
    if (hit) return hit;
    NSDate *start = [NSDate date];
    while (!hit) {
        [g_cond lock];
        uint32_t elapsed = (uint32_t)([[NSDate date] timeIntervalSinceDate:start] * 1000);
        if (elapsed >= maxMs) {
            [g_cond unlock];
            break;
        }
        uint32_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_cond waitUntilDate:deadline];
        [g_cond unlock];
        hit = peekLive(testID);
    }
    return hit;
}

+ (NSUInteger)count {
    ensureInit();
    os_unfair_lock_lock(&g_lock);
    NSUInteger n = g_index.count;
    os_unfair_lock_unlock(&g_lock);
    return n;
}

+ (BOOL)isAttached {
    return g_attached;
}

@end
