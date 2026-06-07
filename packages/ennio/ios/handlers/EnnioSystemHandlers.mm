//
// EnnioSystemHandlers.mm — see header for the op list.
//

#import "EnnioSystemHandlers.h"
#import <dlfcn.h>
#import <objc/runtime.h>
#import "EnnioHandlerUtils.h"

#import "EnnioBootstrap.h"
#import "../bootstrap/EnnioNoAnimations.h"
#import "EnnioFinder.h"
#import "EnnioFinderManager.h"
#import "EnnioOps.h"
#import "EnnioTestIDIndex.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>

#include <cstdio>
#include <stdexcept>
#include <string>

void RegisterEnnioSystemHandlers(void) {
    using namespace ennio;

    // ─── Diagnostic ───────────────────────────────────────────────────

    EnnioControlSocket::registerHandler("ping", [](const std::string &) -> std::string {
        BOOL ready = [EnnioBootstrap isReady];
        std::string out = "{\"pong\":true,\"bootstrap\":\"";
        out += ready ? "ready" : "pending";
        out += "\"}";
        return out;
    });

    EnnioControlSocket::registerHandler("finder_status", [](const std::string &) -> std::string {
        NSString *desc = [EnnioFinderManager attachmentDescription];
        NSUInteger count = [EnnioTestIDIndex count];
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "{\"strategies\":\"%s\",\"indexCount\":%lu}",
                      desc.UTF8String, (unsigned long)count);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("finder_probe", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL indexHit = NO, uiviewHit = NO;
        EnnioOnMainVoid([&]() {
            indexHit = [EnnioTestIDIndex lookup:testID] != nil;
            uiviewHit = [EnnioFinder findViewByTestID:testID] != nil;
        });
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "{\"index\":%s,\"uiview\":%s}",
                      indexHit ? "true" : "false",
                      uiviewHit ? "true" : "false");
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("window_size", [](const std::string &) -> std::string {
        double w = 0, h = 0;
        EnnioOnMainVoid([&]() {
            UIWindow *win = [EnnioBootstrap keyWindow];
            if (win) {
                w = win.bounds.size.width;
                h = win.bounds.size.height;
            }
        });
        char buf[64];
        std::snprintf(buf, sizeof(buf), "{\"w\":%.2f,\"h\":%.2f}", w, h);
        return std::string(buf);
    });

    // Debug-only: dump every view in the key window that has any text
    // hook (accessibilityLabel / value, or KVC-readable `text`). Used
    // to diagnose "element not found" issues when the view tree shape
    // isn't what we expect.
    EnnioControlSocket::registerHandler("dump_views", [](const std::string &) -> std::string {
        NSMutableArray<NSString *> *out = [NSMutableArray new];
        EnnioOnMainVoid([&]() {
            UIWindow *win = [EnnioBootstrap keyWindow];
            if (!win) return;
            NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:win];
            while (stack.count) {
                UIView *v = stack.lastObject;
                [stack removeLastObject];
                NSString *cls = NSStringFromClass([v class]);
                NSString *al = v.accessibilityLabel ?: @"";
                NSString *av = v.accessibilityValue ?: @"";
                NSString *t = @"";
                @try {
                    id raw = [v valueForKey:@"text"];
                    if ([raw isKindOfClass:NSString.class]) t = (NSString *)raw;
                    else if ([raw isKindOfClass:NSAttributedString.class])
                        t = [(NSAttributedString *)raw string];
                } @catch (...) {
                }
                if (al.length || av.length || t.length) {
                    [out addObject:[NSString stringWithFormat:@"%@ | aL=%@ | aV=%@ | t=%@",
                                                              cls, al, av, t]];
                }
                for (UIView *sub in v.subviews.reverseObjectEnumerator) [stack addObject:sub];
            }
        });
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
        NSString *s = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return std::string(s.UTF8String);
    });

    // ─── Alerts ───────────────────────────────────────────────────────

    EnnioControlSocket::registerHandler("alert_present", [](const std::string &) -> std::string {
        BOOL p = NO;
        EnnioOnMainVoid([&]() { p = [EnnioOps isAlertPresent]; });
        return std::string("{\"present\":") + (p ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("alert_text", [](const std::string &) -> std::string {
        NSString *t = @"";
        EnnioOnMainVoid([&]() { t = [EnnioOps alertText]; });
        return std::string("{\"text\":") + EnnioStringJson(t) + "}";
    });

    EnnioControlSocket::registerHandler("alert_buttons", [](const std::string &) -> std::string {
        NSArray<NSString *> *btns = @[];
        EnnioOnMainVoid([&]() { btns = [EnnioOps alertButtons]; });
        return std::string("{\"buttons\":") + EnnioStringArrayJson(btns) + "}";
    });

    EnnioControlSocket::registerHandler("alert_tap", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *btn = EnnioArgString(a, @"buttonText");
        if (!btn.length) throw std::runtime_error("missing buttonText");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps tapAlertButton:btn]; });
        return std::string("{\"tapped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("alert_dismiss", [](const std::string &) -> std::string {
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps dismissAlert]; });
        return std::string("{\"dismissed\":") + (ok ? "true" : "false") + "}";
    });

    // ─── Scroll / nav ─────────────────────────────────────────────────

    EnnioControlSocket::registerHandler("scroll", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        NSString *dir = EnnioArgString(a, @"direction");
        double dist = EnnioArgDouble(a, @"distance", 200);
        if (!testID.length || !dir.length) throw std::runtime_error("missing args");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps scrollTestID:testID direction:dir distance:dist]; });
        return std::string("{\"scrolled\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("scroll_to", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *svID = EnnioArgString(a, @"scrollViewTestID") ?: @"";
        NSString *elID = EnnioArgString(a, @"elementTestID");
        if (!elID.length) throw std::runtime_error("missing elementTestID");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps scrollViewWithTestID:svID toTestID:elID]; });
        return std::string("{\"scrolled\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("back", [](const std::string &) -> std::string {
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps backGesture]; });
        return std::string("{\"popped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hide_keyboard", [](const std::string &) -> std::string {
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps hideKeyboard]; });
        return std::string("{\"hidden\":") + (ok ? "true" : "false") + "}";
    });

    // keyboard_frame: on-screen rect of the software keyboard window, in
    // normalized [0,1] coords, or {visible:false}. The keyboard lives in
    // a SEPARATE high-level UIWindow (UIRemoteKeyboardWindow /
    // UITextEffectsWindow), so the app-window hit-test in is_exposed is
    // blind to it — a button under the keyboard reads as "exposed" while
    // a real touch lands on the keyboard. Callers use this to (a) wait
    // for the keyboard to actually retract after hide_keyboard, and (b)
    // detect when a tap target sits under the keyboard. Frame is the
    // keyboard's input view bounds; an off-screen (retracting/hidden)
    // keyboard reports visible:false.
    EnnioControlSocket::registerHandler("keyboard_frame", [](const std::string &) -> std::string {
        BOOL visible = NO;
        double nx = 0, ny = 0, nw = 0, nh = 0;
        EnnioOnMainVoid([&]() {
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class]) continue;
                UIWindowScene *ws = (UIWindowScene *)scene;
                CGRect screen = ws.coordinateSpace.bounds;
                if (screen.size.width <= 0 || screen.size.height <= 0) continue;
                for (UIWindow *w in ws.windows) {
                    const char *cls = class_getName(w.class);
                    BOOL isKbWindow = strstr(cls, "Keyboard") != NULL ||
                                      strstr(cls, "TextEffects") != NULL;
                    if (!isKbWindow || w.hidden || w.alpha < 0.01) continue;
                    // Find the actual keyboard input view inside the window
                    // (the window spans the screen; the keyboard is its
                    // bottom portion). Walk for UIInputSetHostView /
                    // UIKBKeyplaneView, else fall back to the window frame's
                    // on-screen intersection.
                    __block CGRect kb = CGRectNull;
                    NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:w];
                    while (stack.count) {
                        UIView *v = stack.lastObject;
                        [stack removeLastObject];
                        const char *vc = class_getName(v.class);
                        if (strstr(vc, "UIInputSetHostView") || strstr(vc, "Keyplane") ||
                            strstr(vc, "UIKBKeyplaneView")) {
                            CGRect f = [v convertRect:v.bounds toView:nil];
                            kb = CGRectIsNull(kb) ? f : CGRectUnion(kb, f);
                        }
                        for (UIView *sub in v.subviews) [stack addObject:sub];
                    }
                    CGRect onScreen = CGRectIsNull(kb)
                        ? CGRectIntersection(w.frame, screen)
                        : CGRectIntersection(kb, screen);
                    // A retracted keyboard sits below the screen → empty
                    // intersection, or a sliver. Require it to cover real
                    // bottom area to count as visible.
                    if (!CGRectIsEmpty(onScreen) && onScreen.size.height > screen.size.height * 0.05 &&
                        CGRectGetMaxY(onScreen) >= screen.size.height - 2) {
                        visible = YES;
                        nx = onScreen.origin.x / screen.size.width;
                        ny = onScreen.origin.y / screen.size.height;
                        nw = onScreen.size.width / screen.size.width;
                        nh = onScreen.size.height / screen.size.height;
                    }
                }
            }
        });
        char buf[128];
        snprintf(buf, sizeof(buf),
                 "{\"visible\":%s,\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}",
                 visible ? "true" : "false", nx, ny, nw, nh);
        return std::string(buf);
    });

    // ─── Refresh control ──────────────────────────────────────────────

    EnnioControlSocket::registerHandler("is_refreshing", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = (double)EnnioArgInt(a, @"x", 195);
        double y = (double)EnnioArgInt(a, @"y", 200);
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps isRefreshingAtX:x y:y]; });
        return std::string("{\"refreshing\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("trigger_refresh", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = (double)EnnioArgInt(a, @"x", 195);
        double y = (double)EnnioArgInt(a, @"y", 200);
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps triggerRefreshAtX:x y:y]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    // ─── Clipboard ────────────────────────────────────────────────────

    EnnioControlSocket::registerHandler("clipboard_copy", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *text = EnnioArgString(a, @"text") ?: @"";
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps clipboardCopy:text]; });
        return std::string("{\"copied\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clipboard_paste", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps clipboardPasteIntoTestID:testID]; });
        return std::string("{\"pasted\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clipboard_text", [](const std::string &) -> std::string {
        NSString *t = @"";
        EnnioOnMainVoid([&]() { t = [EnnioOps clipboardText]; });
        return std::string("{\"text\":") + EnnioStringJson(t) + "}";
    });

    // ─── App state ────────────────────────────────────────────────────

    EnnioControlSocket::registerHandler("clear_state", [](const std::string &) -> std::string {
        BOOL ok = NO;
        EnnioOnMainVoid([&]() {
            [EnnioFinder invalidateCache];
            ok = [EnnioOps clearAppData];
        });
        return std::string("{\"cleared\":") + (ok ? "true" : "false") + "}";
    });

    // reload_rn: re-run the JS bundle in place — fresh React tree + reset
    // in-memory stores — WITHOUT killing the process. Backs the
    // suite-level soft reset: re-launching per flow pays process spawn +
    // dyld + framework load + socket reconnect (~6s); a Hermes reload
    // re-runs precompiled bytecode against the already-loaded native
    // stack (~1-2s). Calls RN's RCTTriggerReloadCommandListeners, the
    // same path Cmd-R / the dev-menu reload uses, resolved by dlsym so
    // the dylib needs no RN link (works Paper + Fabric, any RN version
    // that ships the symbol). Pair with clear_state first when the flow
    // needs a wiped sandbox too. Returns ok=false when the symbol isn't
    // present (older RN / fully bridgeless) so the caller falls back to a
    // full relaunch.
    // set_no_animations {enabled}: flip the animation suppressor at
    // runtime — no relaunch — so a per-flow override (a flow tagged
    // keep-animations restoring motion inside a --no-animations suite)
    // works even with the --reuse-app soft reset, which never relaunches.
    EnnioControlSocket::registerHandler("set_no_animations", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        BOOL enabled = a[@"enabled"] ? [a[@"enabled"] boolValue] : YES;
        EnnioOnMainVoid([&]() { [EnnioNoAnimations setEnabled:enabled]; });
        return std::string("{\"ok\":true,\"enabled\":") + (enabled ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("reload_rn", [](const std::string &) -> std::string {
        using ReloadFn = void (*)(NSString *);
        ReloadFn reload = (ReloadFn)dlsym(RTLD_DEFAULT, "RCTTriggerReloadCommandListeners");
        if (!reload) return std::string("{\"ok\":false,\"reason\":\"symbol-absent\"}");
        EnnioOnMainVoid([&]() {
            [EnnioFinder invalidateCache];
            reload(@"ennio soft-reset");
        });
        return std::string("{\"ok\":true}");
    });
}
