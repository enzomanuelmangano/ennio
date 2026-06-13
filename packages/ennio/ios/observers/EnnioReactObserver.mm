//
// EnnioReactObserver.mm — see header for strategy.
//

#import "EnnioReactObserver.h"

#import <UIKit/UIKit.h>
#import <objc/message.h>
#import <mach/mach_time.h>

static NSCondition *g_cond;
static uint64_t g_lastCommitMs = 0;

// Registration state. A source is "attached" the instant we wire it up,
// but only counts as a LIVE signal once it has actually fired at least
// once — see attachmentDescription / the wait fast-paths below for why
// this distinction matters on Fabric.
static bool g_paperRegistered = false;   // NSNotification observer added
static bool g_paperFired = false;        // …and the notification has posted
static bool g_presenterAttached = false; // RCTSurfacePresenter observer added
static bool g_presenterFired = false;    // …and didMountComponents fired

static uint64_t nowMs(void) {
    static mach_timebase_info_data_t info = {0, 0};
    if (info.denom == 0) mach_timebase_info(&info);
    return (mach_absolute_time() * info.numer / info.denom) / 1000000ULL;
}

static void markCommit(void) {
    [g_cond lock];
    g_lastCommitMs = nowMs();
    [g_cond broadcast];
    [g_cond unlock];
}

// A real commit signal is live only when a source has actually fired —
// mere registration (which always "succeeds") is not enough. On Fabric
// the paper notification never posts, so without the fired-gate the
// observer would falsely report attached and the waiters would burn
// their full maxMs cap on every tap waiting for a commit that never
// comes. The presenter observer (Change B) is the real Fabric signal.
static bool hasLiveSignal(void) {
    return g_paperFired || g_presenterFired;
}

// =====================================================================
// Change A — Paper: RCTUIManagerDidUpdateViewsNotification
// =====================================================================
//
// A plain NSNotificationCenter observer keyed by name — no method
// swizzling, no linking against React — so it can never corrupt the
// host app. On Paper / legacy-bridge apps this notification posts once
// per UIView-mutation batch (≈ one commit). On Fabric it NEVER posts;
// the fire-once gate (g_paperFired) keeps us off the slow cap-burn path
// there and lets the caller fall straight through to hash polling.

static bool attachPaperObserver(void) {
    // Notification name is a string constant in RN; we observe by name
    // so we don't link against React.
    NSString *name = @"RCTUIManagerDidUpdateViewsNotification";
    [[NSNotificationCenter defaultCenter] addObserverForName:name
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification * _Nonnull note) {
        (void)note;
        // Only now is the paper signal proven live (the notification
        // really fires on this app). Until this runs, attachmentDescription
        // reports "not paper" so Fabric apps fast-bail instead of waiting.
        g_paperFired = true;
        markCommit();
    }];
    return true;
}

// =====================================================================
// Change B — Fabric: RCTSurfacePresenterObserver (no swizzle)
// =====================================================================
//
// RN ships an official observer protocol on RCTSurfacePresenter whose
// `didMountComponentsWithRootTag:` callback fires once per Fabric mount
// — exactly a commit signal. We register OUR OWN observer object and RN
// calls us; there is no swizzle and no interception of any C++-argument
// method. The only callback arg is NSInteger (a scalar) — impossible to
// corrupt the host the way the removed performTransaction: swizzle did.
//
// We declare the protocol locally (matching React's signature) so the
// dylib never links React. We reach the live presenter purely through
// the Obj-C runtime, defensively: every selector is respondsToSelector:
// -checked before it's sent, and any nil / missing link BAILS to the
// hash-polling fallback rather than crashing.

@protocol EnnioSurfacePresenterObserver <NSObject>
@optional
- (void)willMountComponentsWithRootTag:(NSInteger)rootTag;
- (void)didMountComponentsWithRootTag:(NSInteger)rootTag;
@end

@interface EnnioPresenterObserver : NSObject <EnnioSurfacePresenterObserver>
@end

@implementation EnnioPresenterObserver
- (void)didMountComponentsWithRootTag:(NSInteger)rootTag {
    (void)rootTag; // scalar arg only — never any C++ type
    g_presenterFired = true;
    markCommit();
}
@end

static EnnioPresenterObserver *g_presenterObserver = nil;

// Send an objc message that returns an object, guarded by
// respondsToSelector:. Returns nil if the target can't handle it. ONLY
// ever used for zero-argument, object-returning accessors — never for
// anything taking a C++ argument.
static id ennioSafeGet(id target, SEL sel) {
    if (!target || !sel) return nil;
    if (![target respondsToSelector:sel]) return nil;
    id (*fn)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
    return fn(target, sel);
}

// Walk the Obj-C runtime to the live RCTSurfacePresenter instance.
// Two host shapes:
//   * Bridge mode: RCTBridge.currentBridge → surfacePresenter, commonly
//     via an RCTSurfacePresenterBridgeAdapter.
//   * Bridgeless / new arch: an RCTHost exposes surfacePresenter.
// Everything is respondsToSelector:-guarded and KVC is @try-wrapped;
// any miss returns nil and the caller stays on the fallback.
static id findSurfacePresenter(void) {
    // --- Bridge mode ---------------------------------------------------
    Class bridgeCls = NSClassFromString(@"RCTBridge");
    if (bridgeCls) {
        SEL curSel = NSSelectorFromString(@"currentBridge");
        id bridge = nil;
        if ([bridgeCls respondsToSelector:curSel]) {
            id (*fn)(Class, SEL) = (id (*)(Class, SEL))objc_msgSend;
            bridge = fn(bridgeCls, curSel);
        }
        if (bridge) {
            // Direct accessor (some RN versions expose it on the bridge).
            id presenter = ennioSafeGet(bridge, NSSelectorFromString(@"surfacePresenter"));
            if (presenter) return presenter;
            // Via the bridge adapter, reached by KVC (no public accessor).
            @try {
                id adapter = [bridge valueForKey:@"surfacePresenterBridgeAdapter"];
                id p = ennioSafeGet(adapter, NSSelectorFromString(@"surfacePresenter"));
                if (p) return p;
            } @catch (__unused NSException *e) {
            }
        }
    }

    // --- Bridgeless / new arch ----------------------------------------
    // RCTHost holds the surface presenter. There's no documented global
    // accessor across versions, so locate a live RCTHost instance by
    // scanning the key window's responder/owner graph defensively, then
    // ask it for surfacePresenter. If that fails we simply stay on the
    // fallback — never a crash.
    Class hostCls = NSClassFromString(@"RCTHost");
    if (hostCls) {
        // Some setups expose the host on the root view's delegate chain.
        for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
            if (![scene isKindOfClass:UIWindowScene.class]) continue;
            for (UIWindow *win in ((UIWindowScene *)scene).windows) {
                UIViewController *root = win.rootViewController;
                id host = ennioSafeGet(root, NSSelectorFromString(@"reactHost"));
                if (!host) host = ennioSafeGet(root, NSSelectorFromString(@"host"));
                if (host && [host isKindOfClass:hostCls]) {
                    id p = ennioSafeGet(host, NSSelectorFromString(@"surfacePresenter"));
                    if (p) return p;
                }
            }
        }
    }
    return nil;
}

// Register g_presenterObserver on the live presenter. Idempotent (guards
// against double-registration). Returns true once attached.
static bool attachPresenterObserver(void) {
    if (g_presenterAttached) return true;
    id presenter = findSurfacePresenter();
    if (!presenter) return false;
    SEL addSel = NSSelectorFromString(@"addObserver:");
    if (![presenter respondsToSelector:addSel]) return false;
    if (!g_presenterObserver) g_presenterObserver = [EnnioPresenterObserver new];
    // addObserver: takes an `id` — an objc/pointer arg, safe to send.
    void (*fn)(id, SEL, id) = (void (*)(id, SEL, id))objc_msgSend;
    fn(presenter, addSel, g_presenterObserver);
    g_presenterAttached = true;
    NSLog(@"[Ennio] RN observer: attached RCTSurfacePresenterObserver (Fabric commit signal)");
    return true;
}

// =====================================================================
// EnnioReactObserver
// =====================================================================

@implementation EnnioReactObserver

+ (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_cond = [NSCondition new];
        // RN may not be fully loaded yet at dylib-init time. Defer attach
        // to the main queue.
        dispatch_async(dispatch_get_main_queue(), ^{
            g_paperRegistered = attachPaperObserver();
            // The bridge / host / surface presenter doesn't exist until
            // the JS bundle starts executing — for a Hermes cold start
            // that's hundreds of ms after launch. Try now, then retry on
            // a bounded backoff. Failing all retries leaves us on the
            // hash-polling fallback (never a crash).
            if (!attachPresenterObserver()) {
                for (int i = 0; i < 6; i++) {
                    double delay = 0.5 * (i + 1);
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                                   dispatch_get_main_queue(), ^{
                        attachPresenterObserver();
                    });
                }
            }
        });
    });
}

+ (uint64_t)lastCommitMs {
    return g_lastCommitMs;
}

/// Wait until React has been quiet for stableMs (no commits observed
/// for that long), or until maxMs elapses. Returns 1 if quiet was
/// reached, 0 if the timeout fired while commits were still arriving.
+ (BOOL)waitForReactQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs {
    // No LIVE signal source → nothing to wait on; report quiet so the
    // caller proceeds (it falls back to the hash-based settle elsewhere).
    if (!hasLiveSignal()) return YES;
    uint64_t start = nowMs();
    [g_cond lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceCommit = now - g_lastCommitMs;
        if (sinceCommit >= stableMs) {
            [g_cond unlock];
            return YES;
        }
        uint64_t totalElapsed = now - start;
        if (totalElapsed >= maxMs) {
            [g_cond unlock];
            return NO;
        }
        uint64_t waitMs = stableMs - sinceCommit;
        uint64_t remaining = maxMs - totalElapsed;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
}

+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs {
    // No LIVE signal source → bail immediately; caller falls back to
    // hash polling. CRITICAL for Fabric: the paper notification is
    // registered but never fires there, so keying off registration
    // (instead of having-fired) would wait the full maxMs cap on every
    // tap for a commit that never arrives.
    if (!hasLiveSignal()) return 0;

    uint64_t start = nowMs();
    [g_cond lock];
    while (g_lastCommitMs <= sinceMs) {
        uint64_t now = nowMs();
        uint64_t elapsed = now - start;
        if (elapsed >= maxMs) break;
        uint64_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
    [g_cond unlock];
    return (uint32_t)(nowMs() - start);
}

+ (NSString *)attachmentDescription {
    // Report a source only when its signal is proven LIVE (has fired),
    // not merely registered — so a Fabric app whose paper notification
    // never posts reports "fabric" (presenter) or "none", and the CLI's
    // hasObserver gate (attach !== 'none') stays accurate.
    BOOL paper = g_paperFired;
    BOOL fabric = g_presenterFired;
    if (paper && fabric) return @"both";
    if (fabric) return @"fabric";
    if (paper) return @"paper";
    return @"none";
}

@end
