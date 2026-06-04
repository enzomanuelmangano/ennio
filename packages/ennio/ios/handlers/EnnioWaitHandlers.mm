//
// EnnioWaitHandlers.mm — see header for the op list.
//

#import "EnnioWaitHandlers.h"
#import "EnnioHandlerUtils.h"

#import "EnnioFinder.h"
#import "EnnioOps.h"
#import "EnnioReactObserver.h"
#import "EnnioSettle.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>

#include <cstdio>
#include <string>

// True when `v` (or one of its first `hops` ancestors) is visibly
// animating at the CALayer level: CAAnimations attached, or the
// presentation layer diverging from the model layer (UIView.animate
// sets the model to its final value immediately; only the
// presentation layer moves). Per-frame drivers (Reanimated) update
// the model directly, so callers must ALSO compare the model frame
// across display frames — this check alone can't see them.
static BOOL EnnioLayerChainAnimating(UIView *v, int hops) {
    UIView *cur = v;
    for (int i = 0; cur && i < hops; i++, cur = cur.superview) {
        CALayer *layer = cur.layer;
        if (layer.animationKeys.count > 0) return YES;
        CALayer *pres = layer.presentationLayer;
        if (pres) {
            CGPoint mp = layer.position;
            CGPoint pp = pres.position;
            if (fabs(mp.x - pp.x) > 0.5 || fabs(mp.y - pp.y) > 0.5) return YES;
        }
    }
    return NO;
}

void RegisterEnnioWaitHandlers(void) {
    using namespace ennio;

    // Signal-based target steadiness. Replaces the CLI's timing-window
    // position-stability gate (sample rects over the socket and hope
    // the spacing outwits spring inflection points) with the two
    // ground-truth signals the process actually has:
    //   1. model frame unchanged for `steadyFrames` consecutive
    //      ~16 ms samples — catches Reanimated / any per-frame driver
    //      that writes layer properties directly;
    //   2. no CAAnimations + presentation == model along the ancestor
    //      chain — catches UIKit animations whose model frame is
    //      already final.
    // Returns {ok:true, elapsedMs} once steady; {ok:false} when the
    // budget expires or the view disappears mid-wait.
    EnnioControlSocket::registerHandler("wait_view_steady", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *text = EnnioArgString(a, @"text");
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 800);
        int needFrames = EnnioArgInt(a, @"steadyFrames", 3);
        if (!testID.length && !text.length) throw std::runtime_error("missing testID or text");

        NSDate *start = [NSDate date];
        NSDate *deadline = [start dateByAddingTimeInterval:maxMs / 1000.0];
        CGRect lastFrame = CGRectNull;
        int streak = 0;
        BOOL steady = NO;
        BOOL everFound = NO;

        while ([deadline timeIntervalSinceNow] > 0) {
            BOOL found = NO;
            BOOL animating = NO;
            CGRect frame = CGRectZero;
            EnnioOnMainVoid([&]() {
                UIView *v = testID.length ? [EnnioFinder findViewByTestID:testID]
                                          : [EnnioFinder findViewByText:text];
                if (!v || !v.window) return;
                found = YES;
                frame = [v convertRect:v.bounds toView:nil];
                animating = EnnioLayerChainAnimating(v, 8);
            });
            if (!found) {
                // Target gone mid-wait (remount, navigation). Caller
                // re-finds; nothing to be steady about.
                if (everFound) break;
            } else {
                everFound = YES;
                BOOL same = !CGRectIsNull(lastFrame) &&
                    fabs(frame.origin.x - lastFrame.origin.x) < 0.5 &&
                    fabs(frame.origin.y - lastFrame.origin.y) < 0.5 &&
                    fabs(frame.size.width - lastFrame.size.width) < 0.5 &&
                    fabs(frame.size.height - lastFrame.size.height) < 0.5;
                if (same && !animating) {
                    streak++;
                    if (streak + 1 >= needFrames) { // first matching sample counts
                        steady = YES;
                        break;
                    }
                } else {
                    streak = 0;
                }
                lastFrame = frame;
            }
            [NSThread sleepForTimeInterval:0.016];
        }
        int elapsed = (int)(-[start timeIntervalSinceNow] * 1000.0);
        char buf[96];
        snprintf(buf, sizeof(buf), "{\"ok\":%s,\"elapsedMs\":%d}", steady ? "true" : "false", elapsed);
        return std::string(buf);
    });

    // CALayer-level animation introspection. Frame-hash polling can
    // get stuck on background re-renders (RN idle work, scroll
    // momentum, image decoding) and burns the full cap on every
    // `back` / `waitForAnimationToEnd` call. UIKit transitions
    // (UINavigationController push/pop, modal present/dismiss, tab
    // switch) drive CAAnimations on the host VC's outer view layer
    // or its container view. Limit the check to those host layers —
    // descendant continuous animations (TextInput caret blink,
    // activity indicator spin, loading spinners) are noise.
    EnnioControlSocket::registerHandler("animations_active", [](const std::string &) -> std::string {
        // Use UIViewController.transitionCoordinator — public API,
        // non-nil for the exact duration of any nav stack push/pop
        // and any modal present/dismiss. Walks the full VC chain so
        // a transition deep in the presented-modal stack is caught.
        BOOL active = NO;
        EnnioOnMainVoid([&active]() {
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class]) continue;
                for (UIWindow *w in ((UIWindowScene *)scene).windows) {
                    UIViewController *vc = w.rootViewController;
                    while (vc) {
                        if (vc.transitionCoordinator) { active = YES; return; }
                        if (vc.isBeingPresented || vc.isBeingDismissed) {
                            active = YES; return;
                        }
                        if (vc.presentedViewController) {
                            vc = vc.presentedViewController;
                        } else if (vc.childViewControllers.count) {
                            // Walk all children — UITabBarController has
                            // one child per tab; UINavigationController
                            // exposes the currently-visible VC last.
                            BOOL childHit = NO;
                            for (UIViewController *child in vc.childViewControllers) {
                                if (child.transitionCoordinator) {
                                    active = YES; return;
                                }
                            }
                            (void)childHit;
                            vc = vc.childViewControllers.lastObject;
                        } else {
                            break;
                        }
                    }
                }
            }
        });
        return std::string("{\"active\":") + (active ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("wait_idle", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 5000);
        uint32_t elapsed = [EnnioSettle waitForIdleWithTimeout:maxMs];
        BOOL ok = elapsed < maxMs;
        return EnnioElapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_hash_change", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *hexStr = EnnioArgString(a, @"sinceHash");
        uint64_t baseline = 0;
        if (hexStr.length) {
            unsigned long long v = 0;
            sscanf([hexStr UTF8String], "%llx", &v);
            baseline = (uint64_t)v;
        }
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 1000);
        uint32_t elapsed = [EnnioSettle waitForHashChangeSince:baseline maxMs:maxMs];
        BOOL ok = elapsed < maxMs;
        return EnnioElapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("frame_hash", [](const std::string &) -> std::string {
        uint64_t h = [EnnioSettle currentHash];
        char buf[32];
        snprintf(buf, sizeof(buf), "{\"hash\":\"%llx\"}", (unsigned long long)h);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("react_commit_ts", [](const std::string &) -> std::string {
        uint64_t ts = [EnnioReactObserver lastCommitMs];
        NSString *attach = [EnnioReactObserver attachmentDescription];
        char buf[160];
        std::snprintf(buf, sizeof(buf),
                      "{\"ts\":%llu,\"attach\":\"%s\"}",
                      (unsigned long long)ts, attach.UTF8String);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("wait_react_commit", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 1000);
        uint64_t sinceMs = 0;
        id sinceV = a[@"sinceMs"];
        if ([sinceV isKindOfClass:NSNumber.class]) sinceMs = [(NSNumber *)sinceV unsignedLongLongValue];
        uint32_t elapsed = [EnnioReactObserver waitForCommitSince:sinceMs maxMs:maxMs];
        BOOL ok = elapsed < maxMs;
        return EnnioElapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_commit", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 1000);
        uint32_t stableMs = (uint32_t)EnnioArgInt(a, @"stableMs", 100);
        uint32_t elapsed = [EnnioSettle waitForCommitWithTimeout:maxMs stableForMs:stableMs];
        BOOL ok = elapsed < maxMs;
        return EnnioElapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_react_quiet", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 1000);
        uint32_t stableMs = (uint32_t)EnnioArgInt(a, @"stableMs", 250);
        BOOL ok = [EnnioReactObserver waitForReactQuietStableMs:stableMs maxMs:maxMs];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("wait_presentation_idle", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 2000);
        uint32_t elapsed = [EnnioOps waitForPresentationIdleWithTimeout:maxMs];
        BOOL ok = elapsed < maxMs;
        return EnnioElapsedJson(elapsed, ok);
    });
}
