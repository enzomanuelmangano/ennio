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
#import "EnnioReactObserver.h"
#import "EnnioSettle.h"
#import "EnnioTestIDIndex.h"
#import "PrivateAPI/EnnioTouchSynth.h"
#import "finders/EnnioFinderManager.h"

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
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL indexHit = NO, uiviewHit = NO;
        onMainVoid([&]() {
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
        onMainVoid([&]() {
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

    // Returns whether the view at (testID|text) is exposed for touch
    // at its own center — i.e. UIKit's hitTest at that point resolves
    // to the target view or a descendant. Used by the self-heal
    // retap loop to detect when a tap opened a modal/sheet that now
    // occludes the originally-tapped target (target still findable in
    // the view tree, but no longer receives touches). Without this,
    // re-tapping at the same coords lands on the modal's backdrop and
    // dismisses the modal we just opened.
    EnnioControlSocket::registerHandler("is_exposed", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = argString(a, @"testID");
        NSString *text = argString(a, @"text");
        if (!testID.length && !text.length) throw std::runtime_error("missing selector");
        BOOL exposed = NO;
        BOOL found = NO;
        onMainVoid([&]() {
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
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        NSUInteger total = 0;
        NSUInteger onScreen = 0;
        onMainVoid([&]() {
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
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        NSInteger idx = (NSInteger)argInt(a, @"index", 0);
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        onMainVoid([&]() {
            NSArray<UIView *> *all = [EnnioTestIDIndex lookupAll:testID];
            if (idx < 0 || idx >= (NSInteger)all.count) return;
            UIView *v = all[idx];
            if (v && [EnnioFinder isOnScreen:v]) {
                rect = [EnnioFinder windowRectFor:v];
                found = YES;
            }
        });
        if (!found) throw std::runtime_error("testID not found at index");
        return rectJson(rect);
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

    // Debug: returns top presented VC class chain for the active
    // window. Used to figure out which class names to whitelist in
    // EnnioFinder's cross-process VC synth fallback.
    EnnioControlSocket::registerHandler("top_vc_chain", [](const std::string &) -> std::string {
        NSMutableArray<NSString *> *chain = [NSMutableArray new];
        onMainVoid([&]() {
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
        NSDictionary *a = parseArgs(args);
        if (!a) throw std::runtime_error("invalid args");
        NSString *text = argString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        onMainVoid([&]() {
            rect = [EnnioFinder findAxRectByText:text found:&found];
        });
        if (!found) throw std::runtime_error("ax-text not found");
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
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 1000);
        uint64_t sinceMs = 0;
        id sinceV = a[@"sinceMs"];
        if ([sinceV isKindOfClass:NSNumber.class]) sinceMs = [(NSNumber *)sinceV unsignedLongLongValue];
        uint32_t elapsed = [EnnioReactObserver waitForCommitSince:sinceMs maxMs:maxMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_commit", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 1000);
        uint32_t stableMs = (uint32_t)argInt(a, @"stableMs", 100);
        uint32_t elapsed = [EnnioSettle waitForCommitWithTimeout:maxMs stableForMs:stableMs];
        BOOL ok = elapsed < maxMs;
        return elapsedJson(elapsed, ok);
    });

    EnnioControlSocket::registerHandler("wait_react_quiet", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 1000);
        uint32_t stableMs = (uint32_t)argInt(a, @"stableMs", 250);
        BOOL ok = [EnnioReactObserver waitForReactQuietStableMs:stableMs maxMs:maxMs];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
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

    EnnioControlSocket::registerHandler("wait_find_by_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *testID = argString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 5000);
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        UIView *v = [EnnioFinderManager waitForTestID:testID maxMs:maxMs];
        if (v) {
            onMainVoid([&]() {
                if ([EnnioFinder isOnScreen:v]) {
                    rect = [EnnioFinder windowRectFor:v];
                    found = YES;
                }
            });
        }
        if (!found) throw std::runtime_error("testID not found");
        return rectJson(rect);
    });

    EnnioControlSocket::registerHandler("wait_find_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *text = argString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 5000);
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:maxMs / 1000.0];
        EnnioRect rect = {0, 0, 0, 0};
        BOOL found = NO;
        while ([deadline timeIntervalSinceNow] > 0) {
            onMainVoid([&]() {
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
        return rectJson(rect);
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

    // Activate by text: find the view whose accessibilityLabel /
    // value matches, then invoke its action directly via the same
    // private touch-activate path activate_testid uses. Bypasses the
    // host gesture-recogniser entirely — useful for nav-header back
    // arrows whose recogniser ignores synthetic Down+Up touches that
    // come from outside the XCUITest stack. Returns ok=false when
    // the view doesn't conform to the activate protocol (e.g. plain
    // UILabel without a tap recogniser) so the caller can fall back
    // to a normal tap.
    EnnioControlSocket::registerHandler("activate_by_text", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        NSString *text = argString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        BOOL ok = NO;
        onMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByText:text];
            if (!v || ![EnnioFinder isOnScreen:v]) return;
            ok = [EnnioOps activateView:v];
        });
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

    EnnioControlSocket::registerHandler("first_responder_ready", [](const std::string &args) -> std::string {
        NSDictionary *a = parseArgs(args);
        uint32_t maxMs = (uint32_t)argInt(a, @"maxMs", 2000);
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:maxMs / 1000.0];
        BOOL ready = NO;
        while ([deadline timeIntervalSinceNow] > 0 && !ready) {
            onMainVoid([&]() {
                // Walk every window + presented-VC chain looking for
                // ANY UIResponder that's isFirstResponder + conforms
                // to UIKeyInput. Required so subsequent insert_text
                // doesn't fire into a half-mounted form.
                for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                    if (![scene isKindOfClass:UIWindowScene.class]) continue;
                    for (UIWindow *w in ((UIWindowScene *)scene).windows) {
                        UIViewController *vc = w.rootViewController;
                        NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:w];
                        while (vc) {
                            UIView *vv = vc.viewIfLoaded;
                            if (vv && !vv.superview) [stack addObject:vv];
                            vc = vc.presentedViewController;
                        }
                        while (stack.count) {
                            UIView *v = stack.lastObject;
                            [stack removeLastObject];
                            if (v.isFirstResponder &&
                                [v conformsToProtocol:@protocol(UIKeyInput)]) {
                                ready = YES;
                                break;
                            }
                            for (UIView *sub in v.subviews) [stack addObject:sub];
                        }
                        if (ready) break;
                    }
                    if (ready) break;
                }
            });
            if (ready) break;
            [NSThread sleepForTimeInterval:0.05];
        }
        return std::string("{\"ready\":") + (ready ? "true" : "false") + "}";
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
