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
        BOOL childHijack = NO;
        BOOL enabled = YES;
        EnnioOnMainVoid([&]() {
            UIView *target = testID.length
                ? [EnnioFinder findViewByTestID:testID]
                : [EnnioFinder findViewByText:text];
            if (!target || ![EnnioFinder isOnScreen:target]) return;
            found = YES;
            // enabled: NO when the target (or a near ancestor — the
            // traits often live on the wrapping Pressable when the find
            // matched an inner label) advertises NotEnabled. RN maps
            // accessibilityState.disabled / Button disabled to this
            // trait, and a disabled control swallows the press — the
            // tap "lands" but onPress never fires (bsky Save while the
            // avatar is still processing). Callers wait on this signal
            // instead of firing a dead tap.
            for (UIView *p = target; p; p = p.superview) {
                if (p.accessibilityTraits & UIAccessibilityTraitNotEnabled) { enabled = NO; break; }
                if ([p isKindOfClass:UIControl.class] && !((UIControl *)p).isEnabled) {
                    enabled = NO;
                    break;
                }
                if (p == target.window) break;
            }
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
            // childHijack: hit-test landed on an interactive descendant
            // BEFORE reaching target. iOS dispatches touchesBegan to
            // the deepest interactive view, so the descendant's own
            // onPress fires — not target's. Common shape: feedItem
            // container with an inner avatar/link that opens profile
            // instead of post detail. Caller can use this signal to
            // prefer accessibilityActivate (which invokes target's
            // own handler bypassing hit-test).
            if (exposed && hit && hit != target) {
                for (UIView *c = hit; c && c != target; c = c.superview) {
                    BOOL inter = NO;
                    if ([c isKindOfClass:UIControl.class]) inter = YES;
                    else if ((c.accessibilityTraits & UIAccessibilityTraitButton) ||
                             (c.accessibilityTraits & UIAccessibilityTraitLink)) inter = YES;
                    else {
                        for (UIGestureRecognizer *g in c.gestureRecognizers) {
                            if (g.isEnabled) { inter = YES; break; }
                        }
                    }
                    if (inter) { childHijack = YES; break; }
                }
            }
        });
        char buf[160];
        std::snprintf(buf, sizeof(buf),
                      "{\"found\":%s,\"exposed\":%s,\"childHijack\":%s,\"enabled\":%s}",
                      found ? "true" : "false",
                      exposed ? "true" : "false",
                      childHijack ? "true" : "false",
                      enabled ? "true" : "false");
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

    // Variant of find_by_testid that returns the LARGEST interactive
    // descendant's rect when the testID view itself is a plain
    // (non-interactive) container. Used for tap-target disambiguation
    // when a YAML's `tapOn: id: X` resolves to a wrapper View whose
    // visual center coincidentally lands on a child link (e.g. bsky's
    // NotificationFeedItem wraps Post in a plain <View testID=...>;
    // tap at center hits the inner author Link → wrong nav). When the
    // testID view IS interactive, returns its own rect (same as
    // find_by_testid). When no interactive descendant exists, also
    // returns its own rect — caller can decide via the `kind` field.
    EnnioControlSocket::registerHandler("find_tap_target_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        const char *kindCStr = "self";
        EnnioOnMainVoid([&]() {
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            UIView *target = nil;
            for (UIView *cand in all) {
                if ([EnnioFinder isOnScreen:cand]) { target = cand; break; }
            }
            if (!target) target = [EnnioFinder findViewByTestID:testID];
            if (!target || ![EnnioFinder isOnScreen:target]) return;
            found = YES;
            BOOL targetInteractive = NO;
            if ([target isKindOfClass:UIControl.class]) targetInteractive = YES;
            else if ((target.accessibilityTraits & UIAccessibilityTraitButton) ||
                     (target.accessibilityTraits & UIAccessibilityTraitLink)) targetInteractive = YES;
            else {
                for (UIGestureRecognizer *g in target.gestureRecognizers) {
                    if (g.isEnabled) { targetInteractive = YES; break; }
                }
            }
            if (targetInteractive) {
                rect = [EnnioFinder windowRectFor:target];
                return;
            }
            // Walk descendants — pick the largest interactive view by
            // window-space area. Constrains hit-test to land on a
            // single, dominant onPress target (the post-detail Link
            // wrapping the post body) rather than a small inner
            // child link (author / avatar).
            UIView *best = nil;
            CGFloat bestArea = 0;
            NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:target];
            while (stack.count) {
                UIView *v = stack.lastObject;
                [stack removeLastObject];
                BOOL inter = NO;
                if ([v isKindOfClass:UIControl.class]) inter = YES;
                else if ((v.accessibilityTraits & UIAccessibilityTraitButton) ||
                         (v.accessibilityTraits & UIAccessibilityTraitLink)) inter = YES;
                else {
                    for (UIGestureRecognizer *g in v.gestureRecognizers) {
                        if (g.isEnabled) { inter = YES; break; }
                    }
                }
                if (inter && v != target && v.window) {
                    CGRect wr = [v.window convertRect:v.bounds fromView:v];
                    CGFloat area = wr.size.width * wr.size.height;
                    if (area > bestArea) { bestArea = area; best = v; }
                }
                for (UIView *sub in v.subviews) [stack addObject:sub];
            }
            if (best) {
                rect = [EnnioFinder windowRectFor:best];
                kindCStr = "descendant";
            } else {
                rect = [EnnioFinder windowRectFor:target];
            }
        });
        if (!found) throw std::runtime_error("testID not found");
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f,\"kind\":\"%s\"}",
                      rect.x, rect.y, rect.w, rect.h, kindCStr);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("find_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *text = EnnioArgString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        BOOL relaxed = [a[@"relaxed"] boolValue];
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        NSString *cls = nil;
        EnnioOnMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByText:text relaxed:relaxed];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
                cls = NSStringFromClass(v.class);
            }
        });
        if (!found) throw std::runtime_error("text not found");
        // cls: matched view's class — diagnostic for "tap landed at the
        // wrong rect" investigations (which view actually won the walk).
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f,\"cls\":\"%s\"}",
                      rect.x, rect.y, rect.w, rect.h,
                      cls ? cls.UTF8String : "");
        return std::string(buf);
    });

    // behind_modal: YES when the matched view's hosting VC is NOT in
    // the topmost presented VC's subtree — a modal floats over it and
    // a HID tap at its coords would land on the modal. Used by the
    // runner's tap occlusion gate to wait (signal-driven) for an
    // async-dismissing modal (composer publish → server round-trip)
    // instead of firing a blind tap into the occluder.
    EnnioControlSocket::registerHandler("behind_modal", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *text = EnnioArgString(a, @"text");
        if (!testID.length && !text.length) throw std::runtime_error("missing testID or text");
        BOOL behind = NO;
        EnnioOnMainVoid([&]() {
            UIView *v = nil;
            if (testID.length) v = [EnnioFinder findViewByTestID:testID];
            if (!v && text.length) v = [EnnioFinder findViewByText:text];
            if (v) behind = [EnnioFinder isBehindTopmostPresentation:v];
        });
        return std::string("{\"behind\":") + (behind ? "true" : "false") + "}";
    });

    // target_transitioning: YES while the matched view's hosting VC is
    // mid present/dismiss/push/pop. A HID tap dispatched into a
    // transitioning VC is swallowed by UIKit (feed-reorder: "Go back"
    // tapped while the edit-feeds screen was dismissing — the tap died
    // with it and the flow never left the Feeds screen). The runner
    // checks this right before dispatch and re-resolves after
    // wait_presentation_idle instead of firing a doomed tap.
    EnnioControlSocket::registerHandler("target_transitioning", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *text = EnnioArgString(a, @"text");
        if (!testID.length && !text.length) throw std::runtime_error("missing testID or text");
        BOOL transitioning = NO;
        EnnioOnMainVoid([&]() {
            UIView *v = nil;
            if (testID.length) v = [EnnioFinder findViewByTestID:testID];
            if (!v && text.length) v = [EnnioFinder findViewByText:text];
            if (v) transitioning = [EnnioFinder isViewTransitioning:v];
        });
        return std::string("{\"transitioning\":") + (transitioning ? "true" : "false") + "}";
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

    // get_text: return the text of a matched element. Backs Maestro's
    // copyTextFrom. testID → exact accessibilityIdentifier; text → regex
    // (Maestro treats selector text as regex), else case-insensitive
    // substring, matched against accessibilityLabel/Value and
    // UILabel/UITextView/UITextField text. `index` picks among matches
    // in screen reading order (top→bottom, left→right). Returns {text}.
    EnnioControlSocket::registerHandler("get_text", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *text = EnnioArgString(a, @"text");
        int index = EnnioArgInt(a, @"index", 0);
        if (!testID.length && !text.length) throw std::runtime_error("missing testID or text");

        NSString *result = nil;
        EnnioOnMainVoid([&]() {
            NSRegularExpression *re = nil;
            if (text.length) {
                NSError *err = nil;
                re = [NSRegularExpression regularExpressionWithPattern:text
                                                              options:NSRegularExpressionCaseInsensitive
                                                                error:&err];
                if (err) re = nil;
            }
            NSMutableArray<NSDictionary *> *hits = [NSMutableArray new];
            NSMutableArray<UIView *> *stack = [NSMutableArray new];
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class]) continue;
                for (UIWindow *w in ((UIWindowScene *)scene).windows) {
                    if (!w.hidden) [stack addObject:w];
                }
            }
            while (stack.count) {
                UIView *v = stack.lastObject;
                [stack removeLastObject];
                for (UIView *sub in v.subviews) [stack addObject:sub];
                if (![EnnioFinder isOnScreen:v]) continue;

                NSMutableArray<NSString *> *cands = [NSMutableArray new];
                if ([v isKindOfClass:UILabel.class]) {
                    NSString *t = ((UILabel *)v).text;
                    if (t.length) [cands addObject:t];
                } else if ([v isKindOfClass:UITextView.class]) {
                    NSString *t = ((UITextView *)v).text;
                    if (t.length) [cands addObject:t];
                } else if ([v isKindOfClass:UITextField.class]) {
                    NSString *t = ((UITextField *)v).text;
                    if (t.length) [cands addObject:t];
                }
                if (v.accessibilityLabel.length) [cands addObject:v.accessibilityLabel];
                if ([v.accessibilityValue isKindOfClass:NSString.class] &&
                    [(NSString *)v.accessibilityValue length]) {
                    [cands addObject:(NSString *)v.accessibilityValue];
                }

                BOOL matched = NO;
                NSString *matchedText = nil;
                if (testID.length) {
                    if ([v.accessibilityIdentifier isEqualToString:testID] && cands.count) {
                        matched = YES;
                        matchedText = cands.firstObject;
                    }
                } else {
                    for (NSString *cand in cands) {
                        BOOL ok = NO;
                        if (re) {
                            ok = [re numberOfMatchesInString:cand
                                                     options:0
                                                       range:NSMakeRange(0, cand.length)] > 0;
                        } else {
                            ok = [cand rangeOfString:text
                                             options:NSCaseInsensitiveSearch].location != NSNotFound;
                        }
                        if (ok) {
                            matched = YES;
                            matchedText = cand;
                            break;
                        }
                    }
                }
                if (matched && matchedText) {
                    EnnioRect r = [EnnioFinder windowRectFor:v];
                    [hits addObject:@{ @"text": matchedText, @"y": @(r.y), @"x": @(r.x) }];
                }
            }
            [hits sortUsingComparator:^NSComparisonResult(NSDictionary *p, NSDictionary *q) {
                double dy = [p[@"y"] doubleValue] - [q[@"y"] doubleValue];
                if (fabs(dy) > 1.0) return dy < 0 ? NSOrderedAscending : NSOrderedDescending;
                double dx = [p[@"x"] doubleValue] - [q[@"x"] doubleValue];
                return dx < 0 ? NSOrderedAscending : (dx > 0 ? NSOrderedDescending : NSOrderedSame);
            }];
            if (index >= 0 && index < (int)hits.count) {
                result = hits[index][@"text"];
            }
        });
        if (!result) throw std::runtime_error("get_text: no match");
        NSData *d = [NSJSONSerialization dataWithJSONObject:@{ @"text": result } options:0 error:nil];
        return std::string((const char *)d.bytes, d.length);
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
