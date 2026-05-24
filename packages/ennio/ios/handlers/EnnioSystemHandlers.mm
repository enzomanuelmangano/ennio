//
// EnnioSystemHandlers.mm — see header for the op list.
//

#import "EnnioSystemHandlers.h"
#import "EnnioHandlerUtils.h"

#import "EnnioBootstrap.h"
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
        // backGesture must NOT be wrapped in EnnioOnMainVoid — it
        // dispatches its own main-queue work and blocks on the
        // transition coordinator's completion, which would deadlock
        // if invoked synchronously from the main thread.
        BOOL ok = [EnnioOps backGesture];
        return std::string("{\"popped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hide_keyboard", [](const std::string &) -> std::string {
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps hideKeyboard]; });
        return std::string("{\"hidden\":") + (ok ? "true" : "false") + "}";
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
}
