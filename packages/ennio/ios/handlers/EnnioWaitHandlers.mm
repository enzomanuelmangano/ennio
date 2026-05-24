//
// EnnioWaitHandlers.mm — see header for the op list.
//

#import "EnnioWaitHandlers.h"
#import "EnnioHandlerUtils.h"

#import "EnnioOps.h"
#import "EnnioReactObserver.h"
#import "EnnioSettle.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>

#include <cstdio>
#include <string>

void RegisterEnnioWaitHandlers(void) {
    using namespace ennio;

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
        __block BOOL active = NO;
        EnnioOnMainVoid([&]() {
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
