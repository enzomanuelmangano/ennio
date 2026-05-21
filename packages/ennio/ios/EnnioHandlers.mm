//
// EnnioHandlers.mm
//
// Registers the Unix-socket op handlers. One ObjC file containing one
// +load that installs every handler into EnnioControlSocket via
// std::function lambdas. Handlers parse the args JSON with
// NSJSONSerialization and dispatch to EnnioFinder / EnnioOps /
// EnnioSettle.
//
// The handlers run on socket worker threads. UIKit work is wrapped in
// dispatch_sync(main, ...) where needed. Read-only UIView property
// access is safe off the main thread in practice (these aren't writes
// to the hierarchy), but defensively we hop to main for anything that
// might touch a layout pass.
//

#import "EnnioBootstrap.h"
#import "EnnioFinder.h"
#import "EnnioOps.h"
#import "EnnioSettle.h"
#import "PrivateAPI/EnnioTouchSynth.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>

#include <functional>
#include <stdexcept>
#include <string>

// =====================================================================
// JSON helpers — parse args using NSJSONSerialization. Args are always
// a JSON object literal (the socket framing extracts the substring).
// =====================================================================

static NSDictionary *_Nullable parseArgs(const std::string &args) {
    if (args.empty()) return @{};
    NSData *data = [NSData dataWithBytes:args.data() length:args.size()];
    NSError *err = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
    if (err || ![parsed isKindOfClass:NSDictionary.class]) return nil;
    return (NSDictionary *)parsed;
}

static NSString *argString(NSDictionary *args, NSString *key) {
    id v = args[key];
    return [v isKindOfClass:NSString.class] ? (NSString *)v : nil;
}

static double argDouble(NSDictionary *args, NSString *key, double fallback) {
    id v = args[key];
    if ([v isKindOfClass:NSNumber.class]) return ((NSNumber *)v).doubleValue;
    return fallback;
}

static int argInt(NSDictionary *args, NSString *key, int fallback) {
    id v = args[key];
    if ([v isKindOfClass:NSNumber.class]) return ((NSNumber *)v).intValue;
    return fallback;
}

// JSON encoding helpers — emit a value the socket can pass back.
static std::string boolJson(BOOL b) { return b ? "true" : "false"; }

// Returns a properly-quoted JSON string literal including surrounding
// quotes. Use as the VALUE in `{"key": <stringJson(...)>}`, never wrap
// in additional quotes at the call site.
static std::string stringJson(NSString *s) {
    if (!s) return "\"\"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[ s ?: @"" ]
                                                   options:0
                                                     error:nil];
    NSString *full = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    // full is `["..."]` — strip the brackets.
    if (full.length < 4) return "\"\"";
    NSString *inner = [full substringWithRange:NSMakeRange(1, full.length - 2)];
    return std::string(inner.UTF8String);
}

static std::string rectJson(EnnioRect r) {
    char buf[160];
    std::snprintf(buf, sizeof(buf),
                  "{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f}",
                  r.x, r.y, r.w, r.h);
    return std::string(buf);
}

static std::string elapsedJson(uint32_t elapsedMs, BOOL ok) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "{\"ok\":%s,\"elapsedMs\":%u}",
                  ok ? "true" : "false", elapsedMs);
    return std::string(buf);
}

// Main-thread bounce helper for ops that must run on UIKit's thread.
// Takes a std::function<void()> — caller writes outputs into local
// captures by reference. Two-step pattern: declare the result outside,
// pass a lambda that fills it, then read after the call.
//
// Why not C++-templated onMain<R>: ObjC blocks can't capture C++
// variables, so the simplest stable shape is a void lambda
// that mutates by-reference captures.
static void onMainVoid(std::function<void()> fn) {
    if ([NSThread isMainThread]) {
        fn();
    } else {
        // Block captures the std::function by value; std::function
        // is copyable so this is safe.
        dispatch_sync(dispatch_get_main_queue(), ^{
            fn();
        });
    }
}

// Convert an NSArray<NSString*> into a JSON array literal.
static std::string stringArrayJson(NSArray<NSString *> *arr) {
    if (arr.count == 0) return "[]";
    NSData *data = [NSJSONSerialization dataWithJSONObject:arr options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return std::string(json.UTF8String);
}

// =====================================================================
// Handler registration entry point
// =====================================================================

@interface EnnioHandlers : NSObject
@end

@implementation EnnioHandlers

+ (void)load {
    using namespace ennio;

    EnnioControlSocket::registerHandler("ping", [](const std::string &) -> std::string {
        BOOL ready = [EnnioBootstrap isReady];
        std::string out = "{\"pong\":true,\"bootstrap\":\"";
        out += ready ? "ready" : "pending";
        out += "\"}";
        return out;
    });

    EnnioControlSocket::registerHandler("find_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        onMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByTestID:testID];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("testID not found");
        return rectJson(rect);
    });

    EnnioControlSocket::registerHandler("find_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *text = argString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        onMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByText:text];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("text not found");
        return rectJson(rect);
    });

    EnnioControlSocket::registerHandler("frame", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        EnnioRect rect = {0, 0, 0, 0};
        onMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByTestID:testID];
            if (v) rect = [EnnioFinder windowRectFor:v];
        });
        return rectJson(rect);
    });

    EnnioControlSocket::registerHandler("visible", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL visible = NO;
        onMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByTestID:testID];
            visible = v && [EnnioFinder isOnScreen:v];
        });
        return std::string("{\"visible\":") + (visible ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("wait_idle", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 5000);
        uint32_t elapsed = [EnnioSettle waitForIdleWithTimeout:maxMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_hash_change", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *hexStr = argString(a, @"sinceHash");
        uint64_t baseline = 0;
        if (hexStr.length) {
            unsigned long long v = 0;
            sscanf([hexStr UTF8String], "%llx", &v);
            baseline = (uint64_t)v;
        }
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 1000);
        uint32_t elapsed = [EnnioSettle waitForHashChangeSince:baseline maxMs:maxMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("frame_hash", [](const std::string &) -> std::string {
        uint64_t h = [EnnioSettle currentHash];
        char buf[32];
        snprintf(buf, sizeof(buf), "{\"hash\":\"%llx\"}", (unsigned long long)h);
        return std::string(buf);
    });

    EnnioControlSocket::registerHandler("wait_commit", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 1000);
        uint32_t stableMs = (uint32_t)argInt(a, @"stableMs", 100);
        uint32_t elapsed = [EnnioSettle waitForCommitWithTimeout:maxMs stableForMs:stableMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("tap_tab", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *name = argString(a, @"name");
        if (!name.length) throw std::runtime_error("missing name");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps tapTabByName:name]; });
        return std::string("{\"tapped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("find_tab", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *name = argString(a, @"name");
        if (!name.length) throw std::runtime_error("missing name");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps findTabByName:name]; });
        return std::string("{\"present\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("alert_present", [](const std::string &) -> std::string {
        BOOL p = NO;
        onMainVoid([&]() { p = [EnnioOps isAlertPresent]; });
        return std::string("{\"present\":") + (p ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("alert_text", [](const std::string &) -> std::string {
        NSString *t = @"";
        onMainVoid([&]() { t = [EnnioOps alertText]; });
        return std::string("{\"text\":") + stringJson(t) + "}";
    });

    EnnioControlSocket::registerHandler("alert_buttons", [](const std::string &) -> std::string {
        NSArray<NSString *> *btns = @[];
        onMainVoid([&]() { btns = [EnnioOps alertButtons]; });
        return std::string("{\"buttons\":") + stringArrayJson(btns) + "}";
    });

    EnnioControlSocket::registerHandler("alert_tap", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *btn = argString(a, @"buttonText");
        if (!btn.length) throw std::runtime_error("missing buttonText");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps tapAlertButton:btn]; });
        return std::string("{\"tapped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("alert_dismiss", [](const std::string &) -> std::string {
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps dismissAlert]; });
        return std::string("{\"dismissed\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("scroll", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        NSString *dir = argString(a, @"direction");
        double dist = argDouble(a, @"distance", 200);
        if (!testID.length || !dir.length) throw std::runtime_error("missing args");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps scrollTestID:testID direction:dir distance:dist]; });
        return std::string("{\"scrolled\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("scroll_to", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *svID = argString(a, @"scrollViewTestID") ?: @"";
        NSString *elID = argString(a, @"elementTestID");
        if (!elID.length) throw std::runtime_error("missing elementTestID");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps scrollViewWithTestID:svID toTestID:elID]; });
        return std::string("{\"scrolled\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("back", [](const std::string &) -> std::string {
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps backGesture]; });
        return std::string("{\"popped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hide_keyboard", [](const std::string &) -> std::string {
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps hideKeyboard]; });
        return std::string("{\"hidden\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("activate_at_point", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        double x = (double)argInt(a, @"x", 0);
        double y = (double)argInt(a, @"y", 0);
        BOOL ok = [EnnioTouchSynth activateAtX:x y:y];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("wait_presentation_idle", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 2000);
        uint32_t elapsed = [EnnioOps waitForPresentationIdleWithTimeout:maxMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("is_refreshing", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        double x = (double)argInt(a, @"x", 195);
        double y = (double)argInt(a, @"y", 200);
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps isRefreshingAtX:x y:y]; });
        return std::string("{\"refreshing\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("trigger_refresh", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        double x = (double)argInt(a, @"x", 195);
        double y = (double)argInt(a, @"y", 200);
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps triggerRefreshAtX:x y:y]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("find_child_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *childID = argString(a, @"childTestID");
        NSString *parentID = argString(a, @"parentTestID");
        if (!childID.length || !parentID.length) throw std::runtime_error("missing testIDs");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        onMainVoid([&]() {
            UIView *v = [EnnioOps findChildTestID:childID inParentTestID:parentID];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("child testID not found");
        return rectJson(rect);
    });

    EnnioControlSocket::registerHandler("activate_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps activateByTestID:testID]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("focus_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps focusByTestID:testID]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("insert_text", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *text = argString(a, @"text");
        if (!text) text = @"";
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps insertText:text]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hardware_key", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        int code = argInt(a, @"keyCode", 0);
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps pressHardwareKey:code]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clipboard_copy", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *text = argString(a, @"text") ?: @"";
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps clipboardCopy:text]; });
        return std::string("{\"copied\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clipboard_paste", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps clipboardPasteIntoTestID:testID]; });
        return std::string("{\"pasted\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clipboard_text", [](const std::string &) -> std::string {
        NSString *t = @"";
        onMainVoid([&]() { t = [EnnioOps clipboardText]; });
        return std::string("{\"text\":") + stringJson(t) + "}";
    });

    EnnioControlSocket::registerHandler("swipe_points", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        double x1 = argDouble(a, @"x1", 0);
        double y1 = argDouble(a, @"y1", 0);
        double x2 = argDouble(a, @"x2", 0);
        double y2 = argDouble(a, @"y2", 0);
        double dur = argDouble(a, @"durationMs", 150);
        BOOL ok = NO;
        onMainVoid([&]() { ok = [EnnioOps swipeFromX:x1 y:y1 toX:x2 y:y2 durationMs:dur]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("clear_state", [](const std::string &) -> std::string {
        BOOL ok = NO;
        onMainVoid([&]() {
            [EnnioFinder invalidateCache];
            ok = [EnnioOps clearAppData];
        });
        return std::string("{\"cleared\":") + (ok ? "true" : "false") + "}";
    });

    // Debug-only: dump every view in the key window that has any text
    // hook (accessibilityLabel / value, or KVC-readable `text`). Used
    // to diagnose "element not found" issues when the view tree shape
    // isn't what we expect.
    EnnioControlSocket::registerHandler("dump_views", [](const std::string &) -> std::string {
        NSMutableArray<NSString *> *out = [NSMutableArray new];
        onMainVoid([&]() {
            UIWindow *win = [EnnioBootstrap keyWindow];
            if (!win) return;
            // Iterative DFS — easier than self-referential blocks from
            // inside a C++ lambda.
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
}

@end
