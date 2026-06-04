//
// EnnioInteractionHandlers.mm — see header for the op list.
//

#import "EnnioInteractionHandlers.h"
#import "EnnioHandlerUtils.h"

#import "EnnioFinder.h"
#import "EnnioHIDInjector.h"
#import "EnnioOps.h"
#import "EnnioTouchSynth.h"

#include "EnnioControlSocket.h"

#import <UIKit/UIKit.h>
#import <objc/runtime.h>

#include <stdexcept>
#include <string>

void RegisterEnnioInteractionHandlers(void) {
    using namespace ennio;

    EnnioControlSocket::registerHandler("tap_tab", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *name = EnnioArgString(a, @"name");
        if (!name.length) throw std::runtime_error("missing name");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps tapTabByName:name]; });
        return std::string("{\"tapped\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("find_tab", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *name = EnnioArgString(a, @"name");
        if (!name.length) throw std::runtime_error("missing name");
        BOOL ok = NO;
        BOOL selected = NO;
        EnnioOnMainVoid([&]() {
            ok = [EnnioOps findTabByName:name];
            if (ok) selected = [EnnioOps isTabSelectedByName:name];
        });
        return std::string("{\"present\":") + (ok ? "true" : "false") +
            ",\"selected\":" + (selected ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("activate_at_point", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = (double)EnnioArgInt(a, @"x", 0);
        double y = (double)EnnioArgInt(a, @"y", 0);
        NSString *via = [EnnioTouchSynth activationStrategyAtX:x y:y];
        if (!via) return "{\"ok\":false}";
        return std::string("{\"ok\":true,\"via\":\"") + via.UTF8String + "\"}";
    });

    EnnioControlSocket::registerHandler("activate_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps activateByTestID:testID]; });
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
        NSDictionary *a = EnnioParseArgs(args);
        NSString *text = EnnioArgString(a, @"text");
        if (!text.length) throw std::runtime_error("missing text");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() {
            UIView *v = [EnnioFinder findViewByText:text];
            if (!v || ![EnnioFinder isOnScreen:v]) return;
            ok = [EnnioOps activateView:v];
        });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("focus_testid", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        NSString *testID = EnnioArgString(a, @"testID");
        if (!testID.length) throw std::runtime_error("missing testID");
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps focusByTestID:testID]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("first_responder_ready", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        uint32_t maxMs = (uint32_t)EnnioArgInt(a, @"maxMs", 2000);
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:maxMs / 1000.0];
        BOOL ready = NO;
        while ([deadline timeIntervalSinceNow] > 0 && !ready) {
            EnnioOnMainVoid([&]() {
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
        NSDictionary *a = EnnioParseArgs(args);
        NSString *text = EnnioArgString(a, @"text");
        if (!text) text = @"";
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps insertText:text]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hardware_key", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        int code = EnnioArgInt(a, @"keyCode", 0);
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps pressHardwareKey:code]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    // In-process real-HID injection (idb replacement). Normalized
    // [0,1] coords; UIApplication ingests the IOHIDEvent through its
    // real touch pipeline. Phases composed CLI-side into taps/swipes.
    // Swizzle -[UIApplication sendEvent:] once; count UIEvents that
    // carry touches. Lets the harness prove whether injected HID
    // actually reaches UIKit's event dispatch (delivery) vs lands but
    // hit-tests wrong (coordinates).
    EnnioControlSocket::registerHandler("hid_listen", [](const std::string &) -> std::string {
        static int s_touchEventCount = 0;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            Class cls = UIApplication.class;
            SEL sel = @selector(sendEvent:);
            Method m = class_getInstanceMethod(cls, sel);
            __block IMP orig = method_getImplementation(m);
            IMP repl = imp_implementationWithBlock(^(id self_, UIEvent *ev) {
                if (ev.type == UIEventTypeTouches && ev.allTouches.count > 0) {
                    s_touchEventCount++;
                }
                ((void (*)(id, SEL, UIEvent *))orig)(self_, sel, ev);
            });
            method_setImplementation(m, repl);
        });
        // Reset + report current count.
        int c = s_touchEventCount;
        s_touchEventCount = 0;
        return std::string("{\"touchEvents\":") + std::to_string(c) + "}";
    });

    EnnioControlSocket::registerHandler("hid_probe", [](const std::string &) -> std::string {
        BOOL hasEnqueue = NO, hasHandle = NO, hasBypass = NO;
        EnnioOnMainVoid([&]() {
            UIApplication *app = UIApplication.sharedApplication;
            hasEnqueue = [app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")];
            hasHandle = [app respondsToSelector:NSSelectorFromString(@"_handleHIDEvent:")];
            hasBypass = [app respondsToSelector:NSSelectorFromString(@"_handleHIDEventBypassingUIEvent:")];
        });
        return std::string("{\"enqueue\":") + (hasEnqueue ? "true" : "false") +
            ",\"handle\":" + (hasHandle ? "true" : "false") +
            ",\"bypass\":" + (hasBypass ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hid_down", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = EnnioArgDouble(a, @"x", 0);
        double y = EnnioArgDouble(a, @"y", 0);
        BOOL ok = [EnnioHIDInjector touchDownAtX:x y:y];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hid_move", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = EnnioArgDouble(a, @"x", 0);
        double y = EnnioArgDouble(a, @"y", 0);
        BOOL ok = [EnnioHIDInjector touchMoveToX:x y:y];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("hid_up", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x = EnnioArgDouble(a, @"x", 0);
        double y = EnnioArgDouble(a, @"y", 0);
        BOOL ok = [EnnioHIDInjector touchUpAtX:x y:y];
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });

    EnnioControlSocket::registerHandler("swipe_points", [](const std::string &args) -> std::string {
        NSDictionary *a = EnnioParseArgs(args);
        double x1 = EnnioArgDouble(a, @"x1", 0);
        double y1 = EnnioArgDouble(a, @"y1", 0);
        double x2 = EnnioArgDouble(a, @"x2", 0);
        double y2 = EnnioArgDouble(a, @"y2", 0);
        double dur = EnnioArgDouble(a, @"durationMs", 150);
        BOOL ok = NO;
        EnnioOnMainVoid([&]() { ok = [EnnioOps swipeFromX:x1 y:y1 toX:x2 y:y2 durationMs:dur]; });
        return std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
    });
}
