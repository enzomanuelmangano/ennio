//
// EnnioFindHandlers.mm — see header for the op list.
//

#import "EnnioFindHandlers.h"
#import "EnnioHandlerUtils.h"

#import "EnnioFinder.h"
#import "EnnioFinderManager.h"
#import "EnnioOps.h"
#import "EnnioTestIDIndex.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>

#include <cstdio>
#include <stdexcept>
#include <string>

void RegisterEnnioFindHandlers(void) {
    using namespace ennio;

    // Returns whether the view at (testID|text) is exposed for touch
    // at its own center — i.e. UIKit's hitTest at that point resolves
    // to the target view or a descendant. Used by the self-heal
    // retap loop to detect when a tap opened a modal/sheet that now
    // occludes the originally-tapped target (target still findable in
    // the view tree, but no longer receives touches). Without this,
    // re-tapping at the same coords lands on the modal's backdrop and
    // dismisses the modal we just opened.
    EnnioControlSocket::registerHandler("is_exposed", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *text = EnnioArgString(a, @"text");
        if (!testID.length && !text.length) throw std::runtime_error("missing selector");
        BOOL exposed = NO;
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            UIView *target = testID.length
                ? [EnnioFinder findViewByTestID:testID]
                : [EnnioFinder findViewByText:text];
            if (!target || ![EnnioFinder isOnScreen:target]) return;
            found = YES;
            UIWindow *win = target.window;
            if (!win) return;
            CGRect r = [win convertRect:target.bounds fromView:target];
            CGPoint center = CGPointMake(CGRectGetMidX(r), CGRectGetMidY(r));
            UIView *hit = [win hitTest:center withEvent:nil];
            // Walk up from the hit view — target is exposed if the
            // hit-test ends up at target or a descendant of target.
            UIView *cursor = hit;
            while (cursor) {
                if (cursor == target) { exposed = YES; break; }
                cursor = cursor.superview;
            }
        });
        char buf[64];
        std::snprintf(buf, sizeof(buf),
                      "{\"found\":%s,\"exposed\":%s}",
                      found ? "true" : "false",
                      exposed ? "true" : "false");
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("count_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        NSUInteger total = 0;
        NSUInteger onScreen = 0;
        EnnioOnMainVoid([&]() {
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            total = all.count;
            for (UIView *v in all) {
                if ([EnnioFinder isOnScreen:v]) onScreen++;
            }
        });
        char buf[128];
        std::snprintf(buf, sizeof(buf),
                      "{\"total\":%lu,\"onScreen\":%lu}",
                      (unsigned long)total, (unsigned long)onScreen);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("find_by_testid_nth", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        NSInteger idx = (NSInteger)EnnioArgInt(a, @"index", 0);
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            if (idx < 0 || idx >= (NSInteger)all.count) return;
            UIView *v = all[idx];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("testID not found at index");
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("find_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            // Walk every match in Y-order; lookupAll's filters
            // accept views whose own hidden/alpha are fine, but
            // isOnScreen ALSO checks ancestor hidden/alpha. RN
            // sometimes keeps stale mounts in the tree with hidden
            // ancestors after navigation — the testID stays alive
            // but the view is dark. The first lookupAll hit can be
            // that stale mount, so iterate until we find one that
            // both has a usable frame and is genuinely visible
            // through its ancestor chain.
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            for (UIView *cand in all) {
                if ([EnnioFinder isOnScreen:cand]) {
                    rect = [EnnioFinder windowRectFor:cand];
                    found = YES;
                    break;
                }
            }
            if (!found) {
                UIView *v = [EnnioFinder findViewByTestID:testID];
                if (v && [EnnioFinder isOnScreen:v]) {
                    rect = [EnnioFinder windowRectFor:v];
                    found = YES;
                }
            }
        });
        if (!found) throw std::runtime_error("testID not found");
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("find_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *text = EnnioArgString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByText:text];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("text not found");
        return EnnioRectJson(rect);
    });

    // Debug: returns top presented VC class chain for the active
    // window. Used to figure out which class names to whitelist in
    // EnnioFinder's cross-process VC synth fallback.
    EnnioControlSocket::registerHandler("top_vc_chain", [](const std::string &) -> std::string {
        NSMutableArray<NSString *> *chain = [NSMutableArray new];
        EnnioOnMainVoid([&]() {
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class]) continue;
                for (UIWindow *w in ((UIWindowScene *)scene).windows) {
                    UIViewController *vc = w.rootViewController;
                    while (vc) {
                        [chain addObject:NSStringFromClass([vc class])];
                        vc = vc.presentedViewController;
                    }
                    [chain addObject:@"---scene-end---"];
                }
            }
        });
        NSData *d = [NSJSONSerialization dataWithJSONObject:@{@"chain": chain} options:0 error:nil];
        return std::string((const char *)d.bytes, d.length);
    });

    // In-process accessibility fallback. find_by_text walks the UIView
    // subtree only; that misses content rendered by out-of-process
    // view services (PHPickerViewController, UIDocumentPickerViewC,
    // share sheet) since the host app only holds a UIRemoteView
    // placeholder for those. UIKit synthesises UIAccessibilityElement
    // proxies on the remote view that carry the remote content's
    // a11y labels — find_ax_by_text walks accessibilityElements +
    // accessibilityElementAtIndex: in addition to subviews and picks
    // those proxies up. Returns the proxy's accessibilityFrame in
    // window-space coords so the caller can tap straight through.
    EnnioControlSocket::registerHandler("find_ax_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *text = EnnioArgString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            rect = [EnnioFinder findAxRectByText:text found:&found];
        });
        if (!found) throw std::runtime_error("ax-text not found");
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("frame", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        EnnioRect rect = {0, 0, 0, 0};
        EnnioOnMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByTestID:testID];
            if (v) rect = [EnnioFinder windowRectFor:v];
        });
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("visible", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL visible = NO;
        EnnioOnMainVoid([&]() {
            // Iterate every lookupAll match through isOnScreen — the
            // firstObject can be a stale mount whose ancestor is
            // hidden. Only after exhausting the index do we fall back
            // to the legacy UIKit walk + auto-scroll.
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            for (UIView *cand in all) {
                if ([EnnioFinder isOnScreen:cand]) { visible = YES; return; }
            }
            UIView *v = all.firstObject ?: [EnnioFinder findViewByTestID:testID];
            if (v && [EnnioFinder isOnScreen:v]) { visible = YES; return; }
            // Auto-scroll: Maestro's assertVisible auto-scrolls within
            // the nearest scroll view to surface the target. Walk
            // ancestors for the first UIScrollView and ask it to
            // scroll the target into the visible rect. This matches
            // assertVisible semantics on long profile screens where
            // the asserted element (userBannerImage, etc.) is mounted
            // but scrolled past after a modal-save cycle.
            if (v && v.window) {
                UIView *sv = v.superview;
                while (sv && ![sv isKindOfClass:UIScrollView.class]) sv = sv.superview;
                if ([sv isKindOfClass:UIScrollView.class]) {
                    UIScrollView *scroll = (UIScrollView *)sv;
                    CGRect target = [v convertRect:v.bounds toView:scroll];
                    [scroll scrollRectToVisible:target animated:NO];
                    [scroll layoutIfNeeded];
                    visible = [EnnioFinder isOnScreen:v];
                }
            }
        });
        return std::string("{\"visible\":") + (visible ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("wait_find_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 5000);
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        // Event-driven loop: each time the testID-index broadcasts
        // (a setAccessibilityIdentifier swizzle hit), retry the
        // visibility walk. Multiple views can share a testID — RN
        // keeps stale mounts in the tree with hidden ancestors after
        // navigation, and the first lookupAll hit can be the stale
        // mount. waitForTestID returning a view only proves the
        // identifier exists somewhere; we still have to find the one
        // that's actually visible.
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:maxMs / 1000.0];
        UIView *waited = [EnnioFinderManager waitForTestID:testID maxMs:maxMs];
        while (waited && [deadline timeIntervalSinceNow] > 0) {
            EnnioOnMainVoid([&]() {
                NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
                for (UIView *cand in all) {
                    if ([EnnioFinder isOnScreen:cand]) {
                        rect = [EnnioFinder windowRectFor:cand];
                        found = YES;
                        break;
                    }
                }
                if (!found && [EnnioFinder isOnScreen:waited]) {
                    rect = [EnnioFinder windowRectFor:waited];
                    found = YES;
                }
            });
            if (found) break;
            // No visible match yet — sleep until the next register
            // event or 50 ms, whichever comes first.
            uint32_t remaining = (uint32_t)([deadline timeIntervalSinceNow] * 1000);
            uint32_t step = remaining < 50 ? remaining : 50;
            if (step == 0) break;
            UIView *next = [EnnioFinderManager waitForTestID:testID maxMs:step];
            if (next) waited = next;
        }
        if (!found) throw std::runtime_error("testID not found");
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("wait_find_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *text = EnnioArgString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 5000);
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:maxMs / 1000.0];
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        while ([deadline timeIntervalSinceNow] > 0) {
            EnnioOnMainVoid([&]() {
                UIView *v = [EnnioFinder findViewByText:text];
                if (v && [EnnioFinder isOnScreen:v]) {
                    rect = [EnnioFinder windowRectFor:v];
                    found = YES;
                }
            });
            if (found) break;
            [NSThread sleepForTimeInterval:0.016];
        }
        if (!found) throw std::runtime_error("text not found");
        return EnnioRectJson(rect);
    });

    EnnioControlSocket::registerHandler("find_child_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *childID = EnnioArgString(a, @"childTestID");
        NSString *parentID = EnnioArgString(a, @"parentTestID");
        if (!childID.length || !parentID.length) throw std::runtime_error("missing testIDs");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        EnnioOnMainVoid([&]() {
            UIView *v = [EnnioOps findChildTestID:childID inParentTestID:parentID];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("child testID not found");
        return EnnioRectJson(rect);
    });
}
