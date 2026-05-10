//
// EnnioRuntimeHelper.mm
// Objective-C++ implementation for accessing React Native runtime
//

#import "EnnioRuntimeHelper.h"
#import <React/RCTSurfacePresenter.h>
#import <React/RCTScheduler.h>
#import <react/renderer/core/ShadowNode.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

// Timeout for main thread dispatch (5 seconds)
static const int64_t MAIN_THREAD_TIMEOUT_NS = 5 * NSEC_PER_SEC;

// Dispatch `block` to the main thread, wait up to MAIN_THREAD_TIMEOUT_NS.
// Inline-runs on the main thread to avoid deadlock if the caller is
// already there.
//
// Memory: the semaphore is dispatch_object_t under ARC — the async block
// captures it strongly, so it stays alive until the block signals (even
// if we time out and return). No explicit dispatch_release needed.
static BOOL dispatchSyncMainWithTimeout(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
        return YES;
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
        block();
        dispatch_semaphore_signal(semaphore);
    });
    long result = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, MAIN_THREAD_TIMEOUT_NS));
    if (result != 0) {
        NSLog(@"[Ennio] WARNING: Main thread dispatch timed out after 5 seconds");
        return NO;
    }
    return YES;
}

namespace ennio {

EnnioRuntimeHelper& EnnioRuntimeHelper::getInstance() {
    static EnnioRuntimeHelper instance;
    return instance;
}

void EnnioRuntimeHelper::setSurfacePresenter(void* surfacePresenter) {
    surfacePresenter_ = surfacePresenter;
    NSLog(@"[Ennio] EnnioRuntimeHelper::setSurfacePresenter called with %p", surfacePresenter);
}

// Helper to find surface presenter by looking through runtime objects
// Read-only `[obj performSelector:NSSelectorFromString(name)]` with the
// ARC leak warning quieted. All call sites here are getters; ARC's
// retain-leak heuristic is overcautious for these.
static id performGetter(id obj, NSString* name) {
    SEL sel = NSSelectorFromString(name);
    if (![obj respondsToSelector:sel]) return nil;
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id result = [obj performSelector:sel];
    #pragma clang diagnostic pop
    return result;
}

// Newer Expo / RN: AppDelegate exposes reactNativeFactory whose reactHost
// (or the factory itself in older Expo) carries the surfacePresenter.
static RCTSurfacePresenter* presenterViaAppDelegate() {
    id appDelegate = [UIApplication sharedApplication].delegate;
    NSLog(@"[Ennio] AppDelegate class: %@", NSStringFromClass([appDelegate class]));
    id factory = performGetter(appDelegate, @"reactNativeFactory");
    if (!factory) return nil;
    NSLog(@"[Ennio] Found reactNativeFactory: %@", NSStringFromClass([factory class]));

    id host = performGetter(factory, @"reactHost");
    if (host) {
        NSLog(@"[Ennio] Found reactHost: %@", NSStringFromClass([host class]));
        id presenter = performGetter(host, @"surfacePresenter");
        if (presenter) {
            NSLog(@"[Ennio] Found surfacePresenter via host: %@", presenter);
            return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
        }
    }
    id presenter = performGetter(factory, @"surfacePresenter");
    if (presenter) {
        NSLog(@"[Ennio] Found surfacePresenter on factory: %@", presenter);
        return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
    }

    // Diagnostic: print factory's method list so a future RN/Expo bump
    // doesn't leave us guessing which selector was renamed.
    NSLog(@"[Ennio] Factory methods:");
    unsigned int count;
    Method* methods = class_copyMethodList([factory class], &count);
    for (unsigned int i = 0; i < count && i < 20; i++) {
        NSLog(@"[Ennio]   - %@", NSStringFromSelector(method_getName(methods[i])));
    }
    free(methods);
    return nil;
}

// Fallback: scan every window for an RCTSurface*View and pull the
// presenter via its surface. Catches setups where the AppDelegate path
// is unavailable (third-party RN host, older Expo, naked RN).
static RCTSurfacePresenter* presenterViaWindowScan() {
    NSLog(@"[Ennio] Searching windows for RCTSurfaceHostingView...");
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow* window in ((UIWindowScene*)scene).windows) {
            UIViewController* rootVC = window.rootViewController;
            if (!rootVC || !rootVC.view) continue;
            for (UIView* subview in rootVC.view.subviews) {
                NSString* className = NSStringFromClass([subview class]);
                NSLog(@"[Ennio] Found view: %@", className);
                if (![className containsString:@"RCTSurface"] && ![className containsString:@"RCTRoot"]) continue;
                id surface = performGetter(subview, @"surface");
                if (!surface) continue;
                id presenter = performGetter(surface, @"surfacePresenter");
                if (!presenter) continue;
                NSLog(@"[Ennio] Found surfacePresenter via view: %@", presenter);
                return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
            }
        }
    }
    return nil;
}

static RCTSurfacePresenter* findSurfacePresenterInRuntime() {
    NSLog(@"[Ennio] Searching for surface presenter...");
    if (RCTSurfacePresenter* p = presenterViaAppDelegate()) return p;
    if (RCTSurfacePresenter* p = presenterViaWindowScan()) return p;
    NSLog(@"[Ennio] Could not find surface presenter");
    return nil;
}

std::shared_ptr<facebook::react::UIManager> EnnioRuntimeHelper::getUIManager() {
    NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager called, cached=%p", surfacePresenter_);

    __block std::shared_ptr<facebook::react::UIManager> result = nullptr;

    void (^getUIManagerBlock)(void) = ^{
        @try {
            RCTSurfacePresenter* presenter = nil;

            // Probe cached presenter, but verify it's still alive. After
            // launchApp:clearState the app process restarts but our singleton
            // can still hold a void* to the previous presenter; touching that
            // dangling pointer is a SIGSEGV in objc_retain. Re-find from
            // runtime if the cached one looks dead.
            if (surfacePresenter_) {
                @try {
                    presenter = (__bridge RCTSurfacePresenter*)surfacePresenter_;
                    // Force a method dispatch to surface deallocation as a
                    // catchable exception rather than a SIGSEGV.
                    if (![presenter respondsToSelector:@selector(scheduler)]) {
                        presenter = nil;
                        surfacePresenter_ = nullptr;
                    }
                } @catch (...) {
                    presenter = nil;
                    surfacePresenter_ = nullptr;
                }
                if (presenter) {
                    NSLog(@"[Ennio] Using cached surfacePresenter: %@", presenter);
                }
            }

            // If no cached (or cached looked stale), search runtime fresh.
            if (!presenter) {
                presenter = findSurfacePresenterInRuntime();
                if (presenter) {
                    surfacePresenter_ = (__bridge void*)presenter;
                }
            }

            if (!presenter) {
                NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager: Could not find surface presenter");
                return;
            }

            RCTScheduler* scheduler = [presenter scheduler];
            if (!scheduler) {
                NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager: scheduler is null");
                return;
            }

            NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager: scheduler=%@", scheduler);

            result = [scheduler uiManager];
            NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager: uiManager=%s", result ? "valid" : "null");
        } @catch (NSException *exception) {
            NSLog(@"[Ennio] EnnioRuntimeHelper::getUIManager: Exception: %@", exception);
        }
    };

    // Must access surface presenter and scheduler from main thread
    if ([NSThread isMainThread]) {
        getUIManagerBlock();
    } else {
        dispatchSyncMainWithTimeout(getUIManagerBlock);
    }

    return result;
}

std::shared_ptr<const facebook::react::ShadowNode> EnnioRuntimeHelper::getShadowTreeRoot() {
    NSLog(@"[Ennio] EnnioRuntimeHelper::getShadowTreeRoot called, surfacePresenter_=%p", surfacePresenter_);

    auto uiManager = getUIManager();
    if (!uiManager) {
        NSLog(@"[Ennio] EnnioRuntimeHelper::getShadowTreeRoot: UIManager is null");
        return nullptr;
    }

    NSLog(@"[Ennio] EnnioRuntimeHelper::getShadowTreeRoot: UIManager available");

    // Use a pointer wrapper to capture in lambda (since __block doesn't work with lambdas)
    auto rootNodePtr = std::make_shared<std::shared_ptr<const facebook::react::ShadowNode>>(nullptr);

    void (^getRootBlock)(void) = ^{
        // Get the shadow tree registry and enumerate to find the first surface
        auto& shadowTreeRegistry = uiManager->getShadowTreeRegistry();
        int surfaceCount = 0;

        shadowTreeRegistry.enumerate([&surfaceCount, rootNodePtr](const facebook::react::ShadowTree& shadowTree, bool& stop) {
            surfaceCount++;
            // Get the root from the first surface we find
            *rootNodePtr = shadowTree.getCurrentRevision().rootShadowNode;
            NSLog(@"[Ennio] EnnioRuntimeHelper::getShadowTreeRoot: Found surface %d", surfaceCount);
            stop = true;
        });

        NSLog(@"[Ennio] EnnioRuntimeHelper::getShadowTreeRoot: Total surfaces=%d, rootNode=%s",
              surfaceCount, *rootNodePtr ? "valid" : "null");
    };

    // Shadow tree access should happen on main thread for safety
    if ([NSThread isMainThread]) {
        getRootBlock();
    } else {
        dispatchSyncMainWithTimeout(getRootBlock);
    }

    return *rootNodePtr;
}

bool EnnioRuntimeHelper::isInitialized() const {
    return surfacePresenter_ != nullptr;
}

// ============================================
// Alert/Modal Handling
// ============================================

static UIAlertController* findPresentedAlertController() {
    // Walk every connected window. UIAlertController on iOS 13+ is hosted
    // on its own UIWindowLevelAlert window — not on the app's key window —
    // so a key-window-only lookup misses it.
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow* window in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
            UIViewController* currentVC = window.rootViewController;
            while (currentVC) {
                if ([currentVC isKindOfClass:[UIAlertController class]]) {
                    return (UIAlertController*)currentVC;
                }
                currentVC = currentVC.presentedViewController;
            }
        }
    }
    return nil;
}

bool EnnioRuntimeHelper::isAlertPresent() {
    __block bool result = false;

    void (^block)(void) = ^{
        result = (findPresentedAlertController() != nil);
        NSLog(@"[Ennio] isAlertPresent: %@", result ? @"YES" : @"NO");
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return result;
}

std::string EnnioRuntimeHelper::getAlertText() {
    __block std::string result;

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (alert) {
            NSMutableString* text = [NSMutableString string];
            if (alert.title) {
                [text appendString:alert.title];
            }
            if (alert.message) {
                if (text.length > 0) {
                    [text appendString:@"\n"];
                }
                [text appendString:alert.message];
            }
            result = [text UTF8String];
            NSLog(@"[Ennio] getAlertText: %@", text);
        } else {
            NSLog(@"[Ennio] getAlertText: No alert found");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return result;
}

std::vector<std::string> EnnioRuntimeHelper::getAlertButtons() {
    __block std::vector<std::string> result;

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (alert) {
            for (UIAlertAction* action in alert.actions) {
                if (action.title) {
                    result.push_back([action.title UTF8String]);
                    NSLog(@"[Ennio] getAlertButtons: Found button '%@'", action.title);
                }
            }
        } else {
            NSLog(@"[Ennio] getAlertButtons: No alert found");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return result;
}

} // namespace ennio

// ============================================
// Fast-mode write helpers (file-local)
// ============================================

// Private UIKit shims so we can build a fake UITouch and feed it through
// UIApplication's standard event pipeline. RN Fabric's
// RCTSurfaceTouchHandler watches sendEvent: and routes the touch through
// its responder system, which is the JS-side path Pressable hangs off.
@interface UITouch (EnnioPrivate)
- (void)_setLocationInWindow:(CGPoint)point resetPrevious:(BOOL)reset;
- (void)_setIsFirstTouchForView:(BOOL)isFirst;
@end

@interface UIEvent (EnnioPrivate)
- (void)_addTouch:(UITouch*)touch forDelayedDelivery:(BOOL)delayed;
- (void)_clearTouches;
@end

@interface UIApplication (EnnioPrivate)
- (UIEvent*)_touchesEvent;
@end

// Synthesize a Began -> Ended touch sequence at a view's centre. Returns
// YES if the simulated event was actually delivered. RN Pressable's
// gesture-progress timer expects a small gap between PressIn and
// PressOut; sending both within the same runloop tick can leave the
// touch in an indeterminate state, so we wait one runloop iteration
// and reset the timestamp on the End phase.
/**
 * Synthesise a UITouch (Began + Ended) at an absolute window-coordinate
 * point. UIKit's hit-test routes the touch through the responder chain,
 * which fires Pressable / UIControl / accessibilityActivate handlers
 * regardless of which view owns the gesture. ~5 ms in-process, no HID,
 * no out-of-process driver.
 *
 * Strategy is layered: UIControl chain → tap GR walk-up → RN Gesture
 * Handler direct dispatch → bare sendEvent fallback. Each layer is its
 * own static helper below; `synthesizeTouchAtPoint` is just the wiring.
 */
static BOOL invokeTapGestureRecognizers(UIView* view);

static UIWindow* findKeyWindow(void) {
    UIApplication* app = [UIApplication sharedApplication];
    for (UIScene* scene in app.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow* w in ((UIWindowScene*)scene).windows) {
            if (w.isKeyWindow) return w;
        }
    }
    for (UIScene* scene in app.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene* ws = (UIWindowScene*)scene;
        if (ws.windows.count > 0) return ws.windows.firstObject;
    }
    return nil;
}

// RN Pressable's touch processor inspects touch.view to decide which
// shadow node owns the gesture. Hit-test can return an inner Text /
// Image leaf with no React responder; walk to the nearest RCT* ancestor
// so the touch is attributed to the wrapper React rendered.
static UIView* walkToReactView(UIView* hit) {
    UIView* cursor = hit;
    while (cursor && ![NSStringFromClass([cursor class]) hasPrefix:@"RCT"]) {
        cursor = cursor.superview;
    }
    return cursor ?: hit;
}

// UIControl subclasses (UIButton, RNGestureHandlerButton bound to
// RNNativeViewGestureHandler) wire `onPress` to a UIControlEvent action
// chain. RNGH's BaseButton.onPress only fires when JS sees
// `oldState===Active && state===End`, so plain TouchUpInside is dropped
// as End-without-Active — fire TouchDown first. UIButton ignores the
// extra TouchDown so this is a no-op cost there.
static BOOL tryUIControlChain(UIView* hit) {
    for (UIView* cursor = hit; cursor != nil; cursor = cursor.superview) {
        if (![cursor isKindOfClass:[UIControl class]]) continue;
        UIControl* ctrl = (UIControl*)cursor;
        if (!ctrl.enabled) continue;
        BOOL hasAction = NO;
        for (id t in ctrl.allTargets) {
            if ([ctrl actionsForTarget:t forControlEvent:UIControlEventTouchUpInside].count > 0) {
                hasAction = YES;
                break;
            }
        }
        if (!hasAction) continue;
        [ctrl sendActionsForControlEvents:UIControlEventTouchDown];
        [ctrl sendActionsForControlEvents:UIControlEventTouchUpInside];
        return YES;
    }
    return NO;
}

// Pressable / TouchableOpacity / RNGH attach a UITapGestureRecognizer to
// a wrapper view higher up. Synthesised UITouches reach sendEvent, but
// the GR system doesn't always engage on private-API touches the way it
// does on real HID — walk up invoking any tap-class GR's target directly.
static BOOL tryAncestorTapGestures(UIView* hit) {
    for (UIView* cursor = hit; cursor != nil; cursor = cursor.superview) {
        if (invokeTapGestureRecognizers(cursor)) return YES;
    }
    return NO;
}

static UITouch* makeSynthTouchAtPoint(CGPoint locationInWindow, UIWindow* window, UIView* targetView) {
    UITouch* touch = [[UITouch alloc] init];
    // Each KVC group is wrapped: a future iOS could rename or remove any
    // of these private keys, and a bare setValue:forKey: throws an
    // NSException that escapes silently from the only outer @try (the
    // sendEvent path much further down). One log per missed key beats a
    // silent broken tap.
    @try {
        if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
            [touch _setLocationInWindow:locationInWindow resetPrevious:NO];
        } else {
            [touch setValue:[NSValue valueWithCGPoint:locationInWindow] forKey:@"locationInWindow"];
        }
    } @catch (NSException* e) {
        NSLog(@"[Ennio] makeSynthTouch: failed to set location: %@", e.reason);
    }
    @try {
        [touch setValue:@(UITouchPhaseBegan) forKey:@"phase"];
        [touch setValue:window forKey:@"window"];
        [touch setValue:targetView forKey:@"view"];
        [touch setValue:@(1) forKey:@"tapCount"];
        [touch setValue:@([[NSProcessInfo processInfo] systemUptime]) forKey:@"timestamp"];
    } @catch (NSException* e) {
        NSLog(@"[Ennio] makeSynthTouch: failed to set core fields: %@", e.reason);
    }
    return touch;
}

// RNDummyGestureRecognizer (NativeViewGestureHandler — pressto's
// PressableScale, RNGH RawButton, BaseButton on non-UIControl views)
// only fires `onPress` when its touchesBegan:/touchesEnded: overrides
// run with a real touch. UIKit's GR pipeline doesn't always deliver
// synthesised touches to the overrides — forward via the public
// UIGestureRecognizerSubclass entry points. Class-name prefix detection
// avoids coupling to RNGH headers from inside Ennio's pod target.
static BOOL tryRNGestureHandlerDirect(UIView* hit, UIWindow* window, UIEvent* event, CGPoint locationInWindow) {
    UITouch* touch = makeSynthTouchAtPoint(locationInWindow, window, hit);
    NSSet<UITouch*>* touchSet = [NSSet setWithObject:touch];
    NSTimeInterval beganAt = [[touch valueForKey:@"timestamp"] doubleValue];
    for (UIView* cursor = hit; cursor != nil; cursor = cursor.superview) {
        for (UIGestureRecognizer* gr in cursor.gestureRecognizers) {
            if (!gr.enabled) continue;
            NSString* clsName = NSStringFromClass([gr class]);
            if (![clsName hasPrefix:@"RNDummy"] && ![clsName hasPrefix:@"RNNative"]) continue;
            @try {
                if ([gr respondsToSelector:@selector(touchesBegan:withEvent:)]) {
                    [gr touchesBegan:touchSet withEvent:event];
                }
                [touch setValue:@(UITouchPhaseEnded) forKey:@"phase"];
                [touch setValue:@(beganAt + 0.030) forKey:@"timestamp"];
                if ([gr respondsToSelector:@selector(touchesEnded:withEvent:)]) {
                    [gr touchesEnded:touchSet withEvent:event];
                }
                return YES;
            } @catch (NSException* e) {
                NSLog(@"[Ennio] forward to %@: %@", clsName, e.reason);
            }
        }
    }
    return NO;
}

// Bare Began → 30 ms runloop tick → Ended via UIApplication sendEvent.
// 30 ms is the minimum gap RN's touch handler needs to register Began
// before Ended arrives — shorter gets flagged as touchCancelled, longer
// runs unrelated timers. End uses a fresh UIEvent because reusing
// Began's event is hash-deduped by RN's iOS 26 touch handler.
static BOOL sendSynthUITouchSequence(UIView* targetView, UIWindow* window, CGPoint locationInWindow) {
    UIApplication* app = [UIApplication sharedApplication];
    if (![app respondsToSelector:@selector(_touchesEvent)]) return NO;
    UIEvent* event = [app _touchesEvent];
    if (!event) return NO;

    UITouch* touch = makeSynthTouchAtPoint(locationInWindow, window, targetView);
    NSTimeInterval beganAt = [[touch valueForKey:@"timestamp"] doubleValue];
    if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) {
        [touch _setIsFirstTouchForView:YES];
    }
    @try {
        if ([event respondsToSelector:@selector(_clearTouches)]) [event _clearTouches];
        if ([event respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
            [event _addTouch:touch forDelayedDelivery:NO];
        }
        [app sendEvent:event];
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.030]];

        UIEvent* endEvent = [app respondsToSelector:@selector(_touchesEvent)] ? [app _touchesEvent] : event;
        [touch setValue:@(UITouchPhaseEnded) forKey:@"phase"];
        [touch setValue:@(beganAt + 0.030) forKey:@"timestamp"];
        if (endEvent != event) {
            if ([endEvent respondsToSelector:@selector(_clearTouches)]) [endEvent _clearTouches];
            if ([endEvent respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
                [endEvent _addTouch:touch forDelayedDelivery:NO];
            }
        }
        [app sendEvent:endEvent];
        return YES;
    } @catch (NSException* e) {
        NSLog(@"[Ennio] sendSynthUITouchSequence: %@", e.reason);
        return NO;
    }
}

static BOOL synthesizeTouchAtPoint(CGPoint locationInWindow) {
    UIWindow* window = findKeyWindow();
    if (!window) return NO;
    UIView* hit = [window hitTest:locationInWindow withEvent:nil] ?: window;
    hit = walkToReactView(hit);
    NSLog(@"[Ennio] tapAtPoint window=(%.1f,%.1f) hit=%@",
          locationInWindow.x, locationInWindow.y, NSStringFromClass([hit class]));

    if (tryUIControlChain(hit)) return YES;
    if (tryAncestorTapGestures(hit)) return YES;

    UIApplication* app = [UIApplication sharedApplication];
    if (![app respondsToSelector:@selector(_touchesEvent)]) return NO;
    UIEvent* event = [app _touchesEvent];
    if (!event) return NO;

    if (tryRNGestureHandlerDirect(hit, window, event, locationInWindow)) return YES;
    return sendSynthUITouchSequence(hit, window, locationInWindow);
}

static BOOL synthesizeTouchAtViewCenter(UIView* view) {
    if (!view || !view.window) return NO;
    CGPoint center = CGPointMake(view.bounds.size.width / 2, view.bounds.size.height / 2);
    CGPoint locationInWindow = [view convertPoint:center toView:view.window];
    return sendSynthUITouchSequence(view, view.window, locationInWindow);
}

// Try every reasonable activation path on a view. Returns YES on the first
// one that succeeds.
//
// Order matters. The synthesized UITouch -> sendEvent: path fires RN
// Fabric's RCTSurfaceTouchHandler, which is the only path that
// reliably runs Pressable's onPress on iOS 26 (RN intercepts touches
// inside its own touch processor, not through the standard responder
// chain). Try it first.
//
// Falling back: UIControl.sendActionsForControlEvents covers UIKit
// controls (UITabBarButton, UIButton). accessibilityActivate covers
// VoiceOver-wired widgets. Direct gesture-recognizer invocation
// catches a handful of RN cases where the recognizer is attached but
// the touch processor isn't (e.g. paper architecture, some 3rd-party
// libs).
// Walks the gesture-recognizer list and invokes the target/action of any
// tap gesture recognizer attached to the view. Returns YES if at least
// one action fired. This is the most reliable trigger for RN Pressable
// because Pressable installs a gesture recognizer whose action is the
// onPress handler — synthesised UITouch events go through the touch
// processor and may be filtered (e.g. on third-party RN setups where
// UITouch private API doesn't reach the Pressability state machine).
// Drive a tap-style GR's state machine to fire onPress. Only safe on
// known recogniser classes — system / accessibility GRs (e.g.
// _UIAccessibilityHUDGateGestureRecognizer attached to RCTUITextField)
// SIGSEGV on iOS 26 when state is set outside a real touch interaction.
// The whitelist below covers every tap-firing class encountered in
// practice across the Fabric / RNGH / pressto / TouchableOpacity stacks.
static BOOL canStateDrive(UIGestureRecognizer* gr) {
    NSString* name = NSStringFromClass([gr class]);
    // RN-Gesture-Handler's tap recogniser (used by RNGH BaseButton +
    // pressto's PressableScale + every Gesture.Tap() in user code).
    if ([name isEqualToString:@"RNBetterTapGestureRecognizer"]) return YES;
    // Plain UIKit tap GR — RN's TouchableOpacity / TouchableHighlight on
    // the old bridge add this directly to their wrapper view.
    if ([gr isKindOfClass:[UITapGestureRecognizer class]]) return YES;
    return NO;
}

static BOOL invokeTapGestureRecognizers(UIView* view) {
    if (!view) return NO;
    BOOL fired = NO;
    for (UIGestureRecognizer* gr in view.gestureRecognizers) {
        if (!gr.enabled) continue;
        // Preferred path: drive the GR through Began → Ended via the
        // public `state` setter (UIGestureRecognizerSubclass). UIKit's
        // action-dispatch fires registered targets automatically when
        // state transitions to Ended, with the recogniser's `state`
        // already at Ended — so RNGH's `recognizerState` maps to
        // `RNGestureHandlerStateEnd` and the JS-side onPress fires.
        if (canStateDrive(gr)) {
            @try {
                gr.state = UIGestureRecognizerStateBegan;
                gr.state = UIGestureRecognizerStateEnded;
                fired = YES;
                continue;
            } @catch (NSException* e) {
                NSLog(@"[Ennio] state-drive %@: %@", NSStringFromClass([gr class]), e.reason);
            }
        }
        // Fallback for unrecognised tap-class GRs: walk `_targets` and
        // invoke the action selector. Modern iOS UIGestureRecognizerTarget
        // has been observed to hide the `_action` key on KVC under some
        // configurations — wrap in @try so the warning doesn't propagate.
        @try {
            NSArray* targets = [gr valueForKey:@"_targets"];
            for (id target in targets) {
                id realTarget = [target valueForKey:@"_target"];
                NSString* actionName = nil;
                @try { actionName = [target valueForKey:@"_action"]; } @catch (...) {}
                if (!realTarget || !actionName) continue;
                SEL action = NSSelectorFromString(actionName);
                if (![realTarget respondsToSelector:action]) continue;
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [realTarget performSelector:action withObject:gr];
                #pragma clang diagnostic pop
                fired = YES;
            }
        } @catch (NSException* e) {
            NSLog(@"[Ennio] invokeTapGestureRecognizers: %@", e.reason);
        }
    }
    return fired;
}

/**
 * Try the activation paths that have a verifiable signal of success:
 * UIControl.sendActions (RNGH BaseButton), tap gesture-recognizer KVC
 * (RN Pressable on the legacy bridge), accessibilityActivate. Returns NO
 * if none apply — caller falls back to synthesizeTouch which always
 * "succeeds" but may not actually fire onPress.
 */
static BOOL tryDefiniteActivation(UIView* view) {
    if (!view) return NO;
    if ([view isKindOfClass:[UIControl class]]) {
        UIControl* ctrl = (UIControl*)view;
        if (ctrl.enabled) {
            [ctrl sendActionsForControlEvents:UIControlEventTouchUpInside];
            return YES;
        }
    }
    if (invokeTapGestureRecognizers(view)) return YES;
    if ([view accessibilityActivate]) return YES;
    return NO;
}

static BOOL fireActivation(UIView* view) {
    if (!view) return NO;
    if (tryDefiniteActivation(view)) return YES;
    // Fallback: synthesised UITouch via UIApplication.sendEvent. Reaches
    // RCTSurfaceTouchHandler / RN Fabric's touchesBegan-Ended overrides.
    // Always returns YES (event was dispatched), so caller has no way to
    // tell if onPress actually fired — kept as a last resort.
    if (synthesizeTouchAtViewCenter(view)) return YES;
    return NO;
}

// Mirror UIKit touch-routing rules. Two paths block a tap:
//   1. UIKit's own gate: hidden / alpha~0 / userInteractionEnabled=NO
//      anywhere up the superview chain.
//   2. RN Fabric's pointerEvents="none": implemented as a hitTest:
//      override on the host view, leaving userInteractionEnabled alone.
//      Only a real hit-test from the window catches this.
// Activation paths (sendActionsForControlEvents, GR target invoke,
// accessibilityActivate) bypass both, so we gate explicitly to avoid
// firing a tap that a finger never could.
static BOOL viewIsTappable(UIView* view) {
    if (!view || !view.window) return NO;
    for (UIView* v = view; v; v = v.superview) {
        if (v.hidden || v.alpha < 0.01) return NO;
        if (!v.userInteractionEnabled) return NO;
        // RN Fabric implements pointerEvents="none" on RCTViewComponentView
        // by overriding hitTest: rather than touching userInteractionEnabled.
        // Read the prop via KVC so we reject the tap explicitly.
        @try {
            id pe = [v valueForKey:@"pointerEvents"];
            if ([pe isKindOfClass:[NSString class]] &&
                [(NSString*)pe isEqualToString:@"none"]) return NO;
            if ([pe isKindOfClass:[NSNumber class]] &&
                [(NSNumber*)pe integerValue] == 1) return NO;
        } @catch (__unused NSException* e) {}
    }
    return YES;
}

// Recursively search the view tree for a UIView whose accessibilityIdentifier
// matches the testID. Hidden / size-zero views skipped because they're not
// interactable.
static UIView* findViewByTestID(UIView* root, NSString* testID) {
    if (!root || root.hidden) return nil;
    // Don't filter on alpha here: a Modal mid-fade-in has parent
    // UITransitionView at alpha=0..1, and rejecting alpha<0.01 hides every
    // descendant during the animation. The "is this actually visible to a
    // user / a real tap" decision lives in isViewOnscreen via convertRect
    // + window-bounds intersection.
    if ([root.accessibilityIdentifier isEqualToString:testID]) return root;
    for (UIView* sub in root.subviews) {
        UIView* hit = findViewByTestID(sub, testID);
        if (hit) return hit;
    }
    return nil;
}

// Walk every connected scene window so views inside presented modals /
// child windows (alerts, action sheets, sheet routers) are findable.
static UIView* findViewByTestIDInAllWindows(NSString* testID) {
    if (testID.length == 0) return nil;
    for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene* ws = (UIWindowScene*)scene;
        // Iterate in reverse so the most-recently-presented window wins.
        for (UIWindow* win in [ws.windows reverseObjectEnumerator]) {
            UIView* hit = findViewByTestID(win, testID);
            if (hit) return hit;
        }
    }
    return nil;
}

// Locate the first responder hosting the keyboard, if any.
static UIView* findFirstResponderUnder(UIView* root) {
    if (!root) return nil;
    if (root.isFirstResponder) return root;
    for (UIView* sub in root.subviews) {
        UIView* hit = findFirstResponderUnder(sub);
        if (hit) return hit;
    }
    return nil;
}
static UIView* findFirstResponder() {
    for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene* ws = (UIWindowScene*)scene;
        for (UIWindow* win in [ws.windows reverseObjectEnumerator]) {
            UIView* hit = findFirstResponderUnder(win);
            if (hit) return hit;
        }
    }
    return nil;
}

// Resolve the closest UIScrollView ancestor for a testID. Used by
// scroll / swipe so the caller can just point at any descendant.
static UIScrollView* findEnclosingScrollView(UIView* view) {
    UIView* node = view;
    while (node) {
        if ([node isKindOfClass:[UIScrollView class]]) return (UIScrollView*)node;
        node = node.superview;
    }
    return nil;
}

// Top-most view controller, walking modal / nav stacks.
static UIViewController* topMostViewController(UIViewController* root) {
    if (root.presentedViewController) {
        return topMostViewController(root.presentedViewController);
    }
    if ([root isKindOfClass:[UINavigationController class]]) {
        UINavigationController* nav = (UINavigationController*)root;
        if (nav.visibleViewController) return topMostViewController(nav.visibleViewController);
    }
    if ([root isKindOfClass:[UITabBarController class]]) {
        UITabBarController* tab = (UITabBarController*)root;
        if (tab.selectedViewController) return topMostViewController(tab.selectedViewController);
    }
    return root;
}
static UIViewController* topMostViewControllerForKeyWindow() {
    for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene* ws = (UIWindowScene*)scene;
        for (UIWindow* win in [ws.windows reverseObjectEnumerator]) {
            if (!win.rootViewController) continue;
            return topMostViewController(win.rootViewController);
        }
    }
    return nil;
}

// Pull a UIAlertAction's stored handler block via KVC. Apple keeps the
// handler private but the ivar name is stable across iOS versions.
// After invoking the handler, dismiss via the presenting controller —
// `[alert dismiss...]` only dismisses anything alert presented (which
// is nothing for a leaf alert), it doesn't dismiss alert itself.
static void invokeAlertAction(UIAlertController* alert, UIAlertAction* action) {
    @try {
        id handler = [action valueForKey:@"handler"];
        if (handler) {
            void (^block)(UIAlertAction*) = (void (^)(UIAlertAction*))handler;
            block(action);
        }
    } @catch (NSException* e) {
        NSLog(@"[Ennio] invokeAlertAction: KVC handler lookup failed: %@", e.reason);
    }
    // Try presenter, then alert's own dismiss as a fallback (some iOS
    // versions wire the alert's window so [alert dismiss] does the
    // right thing).
    UIViewController* presenter = alert.presentingViewController;
    if (presenter) {
        [presenter dismissViewControllerAnimated:NO completion:nil];
    } else {
        [alert dismissViewControllerAnimated:NO completion:nil];
    }
}

namespace ennio {

// BFS the descendant subtree looking for a definite activation target.
// Handles RNGH BaseButton: testID lives on the wrapper, but the actual
// UIControl that fires onPress is a child a couple levels in.
static BOOL activateInSubtree(UIView* root) {
    NSMutableArray* queue = [NSMutableArray arrayWithArray:root.subviews];
    while (queue.count > 0) {
        UIView* next = queue.firstObject;
        [queue removeObjectAtIndex:0];
        if (tryDefiniteActivation(next)) return YES;
        [queue addObjectsFromArray:next.subviews];
    }
    return NO;
}

// Climb superview chain. Catches the case where testID is on an inner
// Text leaf and the actual handler is a Pressable wrapper a few levels up.
static BOOL activateInAncestors(UIView* leaf) {
    for (UIView* cursor = leaf.superview; cursor; cursor = cursor.superview) {
        if (tryDefiniteActivation(cursor)) return YES;
    }
    return NO;
}

bool EnnioRuntimeHelper::tap(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) {
            NSLog(@"[Ennio] tap: testID '%@' not found in view tree", tid);
            return;
        }
        if (!viewIsTappable(view)) {
            NSLog(@"[Ennio] tap: '%@' blocked (pointerEvents=none / hidden / userInteractionEnabled=NO on view or ancestor)", tid);
            return;
        }
        if (tryDefiniteActivation(view)) { ok = true; return; }
        if (activateInSubtree(view))     { ok = true; return; }
        if (activateInAncestors(view))   { ok = true; return; }
        // Last resort: synthesise a UITouch on the view itself. Reaches
        // vanilla Pressable via RCTSurfaceTouchHandler. Always reports YES
        // even if no responder claims the touch — keep this last so a
        // false-positive doesn't pre-empt a real activation path.
        if (synthesizeTouchAtViewCenter(view)) { ok = true; return; }
        NSLog(@"[Ennio] tap: '%@' has no activation path (class=%@, traits=0x%llx, isAccessibilityElement=%d)",
              tid, NSStringFromClass([view class]), (unsigned long long)view.accessibilityTraits, view.isAccessibilityElement);
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

std::tuple<double, double, double, double>
EnnioRuntimeHelper::getViewWindowFrame(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block double rx = 0, ry = 0, rw = 0, rh = 0;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view || !view.window) return;
        CGRect inWindow = [view convertRect:view.bounds toView:view.window];
        rx = inWindow.origin.x;
        ry = inWindow.origin.y;
        rw = inWindow.size.width;
        rh = inWindow.size.height;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return {rx, ry, rw, rh};
}

std::pair<double, double> EnnioRuntimeHelper::getSurfaceOffset() {
    __block double ox = 0, oy = 0;
    void (^block)(void) = ^{
        UIWindow* window = findKeyWindow();
        if (!window) return;
        UIView* root = window.rootViewController.view;
        if (!root) return;
        CGRect inWindow = [root convertRect:root.bounds toView:window];
        ox = inWindow.origin.x;
        oy = inWindow.origin.y;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return {ox, oy};
}

std::pair<double, double> EnnioRuntimeHelper::getKeyWindowSize() {
    __block double w = 0, h = 0;
    void (^block)(void) = ^{
        UIWindow* window = findKeyWindow();
        if (!window) return;
        w = window.bounds.size.width;
        h = window.bounds.size.height;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return {w, h};
}

bool EnnioRuntimeHelper::isViewOnscreen(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool onscreen = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view || !view.window) return;
        CGRect viewRect = [view convertRect:view.bounds toView:view.window];
        if (viewRect.size.width <= 0 || viewRect.size.height <= 0) return;
        CGRect winRect = view.window.bounds;
        if (!CGRectIntersectsRect(viewRect, winRect)) return;

        // Walk ancestors: hidden / alpha~0 hides this view. Mirrors
        // UIKit's hit-test pipeline.
        for (UIView* v = view; v != nil; v = v.superview) {
            if (v.hidden || v.alpha < 0.01) return;
        }

        // Z-order / occlusion. A modal/sheet/alert presented above the
        // view's window blocks any finger from reaching it. Reject if a
        // higher-level window covers the view's centre.
        CGPoint centre = CGPointMake(CGRectGetMidX(viewRect), CGRectGetMidY(viewRect));
        UIWindow* targetWindow = view.window;
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* w in ((UIWindowScene*)scene).windows) {
                if (w.hidden || w == targetWindow) continue;
                if (w.windowLevel <= targetWindow.windowLevel) continue;
                CGPoint pt = [w convertPoint:centre fromWindow:targetWindow];
                if ([w hitTest:pt withEvent:nil]) return;
            }
        }
        onscreen = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return onscreen;
}

bool EnnioRuntimeHelper::tapAtScreenPoint(double x, double y) {
    __block bool ok = false;
    void (^block)(void) = ^{
        // Fabric layout is React-surface-relative — origin (0,0) sits
        // below the system status bar / notch. UIWindow.sendEvent
        // expects window coords, so add the surface's offset within
        // its window before synthesising the touch.
        UIWindow* keyWindow = findKeyWindow();
        CGPoint point = CGPointMake((CGFloat)x, (CGFloat)y);
        if (keyWindow) {
            // The React surface is the first non-trivial child of the
            // window's root. Find it and convert.
            UIView* surface = keyWindow.rootViewController.view;
            if (surface) {
                CGRect inWindow = [surface convertRect:surface.bounds toView:keyWindow];
                point.x += inWindow.origin.x;
                point.y += inWindow.origin.y;
            }
        }
        ok = synthesizeTouchAtPoint(point);
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::swipeAtPoints(double x1, double y1, double x2, double y2, double durationMs) {
    if (durationMs <= 0) {
        NSLog(@"[Ennio] swipeAtPoints: invalid durationMs=%.1f, must be > 0", durationMs);
        return false;
    }
    __block bool ok = false;
    void (^block)(void) = ^{
        // Resolve the React surface offset the same way tapAtScreenPoint
        // does — both endpoints are React-surface-relative when the caller
        // is forwarding maestro yaml `swipe: start: ...` coords.
        UIApplication* app = [UIApplication sharedApplication];
        UIWindow* keyWindow = findKeyWindow();
        CGFloat offX = 0, offY = 0;
        if (keyWindow && keyWindow.rootViewController.view) {
            UIView* surface = keyWindow.rootViewController.view;
            CGRect inWindow = [surface convertRect:surface.bounds toView:keyWindow];
            offX = inWindow.origin.x;
            offY = inWindow.origin.y;
        }
        CGPoint start = CGPointMake((CGFloat)x1 + offX, (CGFloat)y1 + offY);
        CGPoint end = CGPointMake((CGFloat)x2 + offX, (CGFloat)y2 + offY);

        if (!keyWindow) keyWindow = app.keyWindow;
        if (!keyWindow) { ok = NO; return; }

        // Fast path: the start point lands inside a UIScrollView. Any
        // RN ScrollView / FlatList / FlashList ends up as one. Compute
        // the new offset from the swipe delta (negated — content moves
        // opposite to the finger) and clamp to the scrollable bounds.
        UIView* hit = [keyWindow hitTest:start withEvent:nil];
        UIScrollView* scrollView = nil;
        for (UIView* cursor = hit; cursor != nil; cursor = cursor.superview) {
            if ([cursor isKindOfClass:[UIScrollView class]]) {
                scrollView = (UIScrollView*)cursor;
                break;
            }
        }
        if (scrollView) {
            CGFloat dx = end.x - start.x;
            CGFloat dy = end.y - start.y;
            CGPoint newOffset = scrollView.contentOffset;
            newOffset.x -= dx;
            newOffset.y -= dy;
            CGFloat maxX = MAX(0, scrollView.contentSize.width - scrollView.bounds.size.width);
            CGFloat maxY = MAX(0, scrollView.contentSize.height - scrollView.bounds.size.height);
            newOffset.x = MAX(0, MIN(newOffset.x, maxX));
            newOffset.y = MAX(0, MIN(newOffset.y, maxY));
            // Pagination snapping is driven by the pan recogniser
            // deciding "this gesture crossed a page boundary". A direct
            // `setContentOffset:animated:NO` skips the recogniser
            // entirely; RN's RCTScrollView (Fabric) sees the offset
            // change before any RCTScrollEvent fires and re-syncs from
            // the React-side state — page snaps back to 0. Use the
            // animated setter so the UIScrollView fires the proper
            // begin/end-decelerating events; momentumScrollEnd then
            // updates React state and the page advances cleanly.
            [scrollView setContentOffset:newOffset animated:scrollView.pagingEnabled];
            ok = YES;
            return;
        }

        // Slow path: drive a synthesised UITouch sequence with phase=Moved
        // updates between Began and Ended. Lets us pan a sheet, drive a
        // UIPanGestureRecognizer attached to a non-scroll view, etc.
        // Pick step count so each Move is ~30 ms — that's the cadence
        // RNGH and UIKit gesture recognisers expect for a "real" swipe.
        UIView* startView = hit ?: keyWindow;
        UIView* reactView = startView;
        while (reactView && ![NSStringFromClass([reactView class]) hasPrefix:@"RCT"]) {
            reactView = reactView.superview;
        }
        if (reactView) startView = reactView;

        const int totalMs = durationMs > 0 ? durationMs : 200;
        const int stepMs = 30;
        const int steps = MAX(4, totalMs / stepMs);
        UIEvent* event = [app respondsToSelector:@selector(_touchesEvent)] ? [app _touchesEvent] : nil;
        if (!event) { ok = NO; return; }

        UITouch* touch = [[UITouch alloc] init];
        if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
            [touch _setLocationInWindow:start resetPrevious:NO];
        } else {
            [touch setValue:[NSValue valueWithCGPoint:start] forKey:@"locationInWindow"];
        }
        [touch setValue:@(UITouchPhaseBegan) forKey:@"phase"];
        [touch setValue:keyWindow forKey:@"window"];
        [touch setValue:startView forKey:@"view"];
        [touch setValue:@(1) forKey:@"tapCount"];
        NSTimeInterval beganAt = [[NSProcessInfo processInfo] systemUptime];
        [touch setValue:@(beganAt) forKey:@"timestamp"];
        if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) {
            [touch _setIsFirstTouchForView:YES];
        }

        @try {
            if ([event respondsToSelector:@selector(_clearTouches)]) [event _clearTouches];
            if ([event respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
                [event _addTouch:touch forDelayedDelivery:NO];
            }
            [app sendEvent:event];

            for (int i = 1; i < steps; i++) {
                CGFloat t = (CGFloat)i / (CGFloat)steps;
                CGPoint mid = CGPointMake(start.x + (end.x - start.x) * t,
                                          start.y + (end.y - start.y) * t);
                if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
                    [touch _setLocationInWindow:mid resetPrevious:NO];
                }
                [touch setValue:@(UITouchPhaseMoved) forKey:@"phase"];
                [touch setValue:@(beganAt + (stepMs * i) / 1000.0) forKey:@"timestamp"];
                UIEvent* moveEvent = [app respondsToSelector:@selector(_touchesEvent)] ? [app _touchesEvent] : event;
                if (moveEvent != event) {
                    if ([moveEvent respondsToSelector:@selector(_clearTouches)]) [moveEvent _clearTouches];
                    if ([moveEvent respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
                        [moveEvent _addTouch:touch forDelayedDelivery:NO];
                    }
                }
                [app sendEvent:moveEvent];
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:stepMs / 1000.0]];
            }

            if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
                [touch _setLocationInWindow:end resetPrevious:NO];
            }
            [touch setValue:@(UITouchPhaseEnded) forKey:@"phase"];
            [touch setValue:@(beganAt + totalMs / 1000.0) forKey:@"timestamp"];
            UIEvent* endEvent = [app respondsToSelector:@selector(_touchesEvent)] ? [app _touchesEvent] : event;
            if (endEvent != event) {
                if ([endEvent respondsToSelector:@selector(_clearTouches)]) [endEvent _clearTouches];
                if ([endEvent respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
                    [endEvent _addTouch:touch forDelayedDelivery:NO];
                }
            }
            [app sendEvent:endEvent];
            ok = YES;
        } @catch (NSException* e) {
            NSLog(@"[Ennio] swipeAtPoints: %@", e.reason);
            ok = NO;
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::pressHardwareKey(double keyCode) {
    __block bool ok = false;
    void (^block)(void) = ^{
        // Walk the key window's responder chain to the current first
        // responder. UIKeyInput is the protocol UITextInput descends
        // from; insertText: / deleteBackward are the standard hooks.
        UIWindow* keyWindow = findKeyWindow();
        if (!keyWindow) { ok = NO; return; }

        UIResponder* fr = nil;
        // Crawl the view tree for whatever has isFirstResponder set —
        // findFirstResponder lives elsewhere in this file but as a
        // file-local helper, so duplicate the trivial walk here to
        // avoid forward-declaration churn.
        NSMutableArray<UIView*>* stack = [NSMutableArray arrayWithObject:keyWindow];
        while (stack.count) {
            UIView* v = stack.lastObject;
            [stack removeLastObject];
            if (v.isFirstResponder) { fr = v; break; }
            for (UIView* sub in v.subviews) [stack addObject:sub];
        }
        if (!fr || ![fr conformsToProtocol:@protocol(UIKeyInput)]) { ok = NO; return; }
        id<UIKeyInput> input = (id<UIKeyInput>)fr;

        // Nitro hands us the keycode as a double (TS `number`); narrow
        // it for the switch.
        const int code = (int)keyCode;
        switch (code) {
            case 42: // backspace
                [input deleteBackward];
                ok = YES;
                break;
            case 40: // return
                [input insertText:@"\n"];
                ok = YES;
                break;
            case 44: // space
                [input insertText:@" "];
                ok = YES;
                break;
            default:
                ok = NO;
                break;
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::doubleTap(const std::string& testID) {
    if (!tap(testID)) return false;
    [NSThread sleepForTimeInterval:0.12];
    return tap(testID);
}

// Recursive label search across UIKit. Picks the smallest matching frame
// (most specific element) — important because RN's tab bar has both the
// outer container (full bar) and the per-item button carrying the label.
//
// VoiceOver / UITabBar augment accessibilityLabel with extra context
// ("Home, Tab, 1 of 4"), so we try exact match first then CONTAINS.
// Match `label` against `needle`: exact, then whole-word case-insensitive
// CONTAINS so "Home" matches "Home, Tab" but not "Welcome Home".
static BOOL labelMatchesText(NSString* label, NSString* needle) {
    if (!label) return NO;
    if ([label isEqualToString:needle]) return YES;
    NSRange r = [label rangeOfString:needle options:NSCaseInsensitiveSearch];
    if (r.location == NSNotFound) return NO;
    NSCharacterSet* letters = [NSCharacterSet letterCharacterSet];
    BOOL leftOk = r.location == 0 || ![letters characterIsMember:[label characterAtIndex:r.location - 1]];
    BOOL rightOk = r.location + r.length == label.length
                   || ![letters characterIsMember:[label characterAtIndex:r.location + r.length]];
    return leftOk && rightOk;
}

// Hit-test at the candidate's centre and confirm it (or a descendant) is
// the topmost view. A Stack-pushed screen leaves the predecessor's
// UIViews in the tree but covers them — without this guard the label
// finder taps a hidden tab bar.
static BOOL viewIsHittableAtCenter(UIView* view) {
    UIWindow* win = view.window;
    if (!win) return YES;
    CGRect inWindow = [view convertRect:view.bounds toView:win];
    CGPoint centre = CGPointMake(CGRectGetMidX(inWindow), CGRectGetMidY(inWindow));
    UIView* topMost = [win hitTest:centre withEvent:nil];
    for (UIView* cursor = topMost; cursor; cursor = cursor.superview) {
        if (cursor == view) return YES;
    }
    return NO;
}

// Smallest hittable view whose accessibility label matches `text`.
// Caller iterates root windows; this recurses into one tree.
static UIView* findLabelMatch(UIView* root, NSString* text, UIView* best) {
    if (!root || root.hidden || root.alpha < 0.01) return best;
    if (labelMatchesText(root.accessibilityLabel, text) && viewIsHittableAtCenter(root)) {
        CGFloat rootArea = root.bounds.size.width * root.bounds.size.height;
        CGFloat bestArea = best ? best.bounds.size.width * best.bounds.size.height : CGFLOAT_MAX;
        if (rootArea < bestArea) best = root;
    }
    for (UIView* sub in root.subviews) {
        best = findLabelMatch(sub, text, best);
    }
    return best;
}

std::tuple<double, double, double, double>
EnnioRuntimeHelper::getViewWindowFrameByLabel(const std::string& text) {
    NSString* label = [NSString stringWithUTF8String:text.c_str()];
    __block double rx = 0, ry = 0, rw = 0, rh = 0;
    void (^block)(void) = ^{
        UIView* hit = nil;
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
                hit = findLabelMatch(win, label, hit);
            }
        }
        if (!hit || !hit.window) return;
        CGRect inWindow = [hit convertRect:hit.bounds toView:hit.window];
        rx = inWindow.origin.x;
        ry = inWindow.origin.y;
        rw = inWindow.size.width;
        rh = inWindow.size.height;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return {rx, ry, rw, rh};
}

bool EnnioRuntimeHelper::tapByLabel(const std::string& text) {
    NSString* label = [NSString stringWithUTF8String:text.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* hit = nil;
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
                hit = findLabelMatch(win, label, hit);
            }
        }
        if (!hit) {
            NSLog(@"[Ennio] tapByLabel: no UIView matched label '%@'", label);
            return;
        }
        // Try the matched view + every ancestor up to the window. RN often
        // attaches the gesture recognizer on a wrapper, not on the leaf
        // text label that carries accessibilityLabel.
        UIView* cursor = hit;
        while (cursor) {
            if (fireActivation(cursor)) { ok = true; return; }
            cursor = cursor.superview;
        }
        // Last-resort: synthesized UITouch on the matched view's centre.
        if (synthesizeTouchAtViewCenter(hit)) { ok = true; return; }
        NSLog(@"[Ennio] tapByLabel: no activation path on '%@' or any ancestor", label);
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::longPress(const std::string& testID, int durationMs) {
    // RN's longPress is driven by a touch-progress timer that we can't
    // synthesize without real UITouch events. As a best effort, fire
    // accessibilityActivate (matches what VoiceOver users get) and let
    // the duration argument be advisory.
    (void)durationMs;
    return tap(testID);
}

// Recursively look for a UITextInput descendant. RN often nests the
// actual UITextField several levels under the testID-bearing wrapper.
static UIView* findTextInputDescendant(UIView* root) {
    if (!root) return nil;
    if ([root conformsToProtocol:@protocol(UITextInput)]) return root;
    for (UIView* sub in root.subviews) {
        UIView* hit = findTextInputDescendant(sub);
        if (hit) return hit;
    }
    return nil;
}

bool EnnioRuntimeHelper::typeText(const std::string& testID, const std::string& text) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    NSString* str = [NSString stringWithUTF8String:text.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) {
            NSLog(@"[Ennio] typeText: testID '%@' not found", tid);
            return;
        }
        UIView* input = findTextInputDescendant(view);
        if (!input) {
            NSLog(@"[Ennio] typeText: '%@' has no UITextInput descendant (class=%@)",
                  tid, NSStringFromClass([view class]));
            return;
        }
        if (![input isFirstResponder]) [input becomeFirstResponder];
        [(id<UITextInput>)input insertText:str];
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::clearText(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) return;
        UIView* target = view;
        if (![target conformsToProtocol:@protocol(UITextInput)]) {
            for (UIView* sub in view.subviews) {
                if ([sub conformsToProtocol:@protocol(UITextInput)]) { target = sub; break; }
            }
        }
        if (![target conformsToProtocol:@protocol(UITextInput)]) return;
        if (![target isFirstResponder]) [target becomeFirstResponder];
        // Select-all then delete fires a single UITextInput change so
        // React sees one onChangeText with empty string.
        if ([target respondsToSelector:@selector(selectAll:)]) {
            [target performSelector:@selector(selectAll:) withObject:nil];
        }
        if ([target respondsToSelector:@selector(deleteBackward)]) {
            [target performSelector:@selector(deleteBackward)];
        }
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::eraseText(const std::string& testID, int count) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) return;
        UIView* target = view;
        if (![target conformsToProtocol:@protocol(UITextInput)]) {
            for (UIView* sub in view.subviews) {
                if ([sub conformsToProtocol:@protocol(UITextInput)]) { target = sub; break; }
            }
        }
        if (![target conformsToProtocol:@protocol(UITextInput)]) return;
        if (![target isFirstResponder]) [target becomeFirstResponder];
        for (int i = 0; i < count; i++) {
            if ([target respondsToSelector:@selector(deleteBackward)]) {
                [target performSelector:@selector(deleteBackward)];
            }
        }
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::pressKey(const std::string& testID, const std::string& keyName) {
    NSString* key = [[NSString stringWithUTF8String:keyName.c_str()] lowercaseString];
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = tid.length > 0 ? findViewByTestIDInAllWindows(tid) : findFirstResponder();
        if (!view) return;
        UIView* target = view;
        if (![target conformsToProtocol:@protocol(UITextInput)]) {
            for (UIView* sub in view.subviews) {
                if ([sub conformsToProtocol:@protocol(UITextInput)]) { target = sub; break; }
            }
        }
        if (![target conformsToProtocol:@protocol(UITextInput)]) return;
        if (![target isFirstResponder]) [target becomeFirstResponder];

        if ([key isEqualToString:@"backspace"] || [key isEqualToString:@"delete"]) {
            if ([target respondsToSelector:@selector(deleteBackward)]) {
                [target performSelector:@selector(deleteBackward)];
                ok = true;
            }
        } else if ([key isEqualToString:@"return"] || [key isEqualToString:@"enter"]) {
            [(id<UITextInput>)target insertText:@"\n"];
            ok = true;
        } else if ([key isEqualToString:@"tab"]) {
            [(id<UITextInput>)target insertText:@"\t"];
            ok = true;
        } else if ([key isEqualToString:@"space"]) {
            [(id<UITextInput>)target insertText:@" "];
            ok = true;
        } else if (key.length == 1) {
            [(id<UITextInput>)target insertText:key];
            ok = true;
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

// Find the topmost user-visible UIScrollView in a window tree. Used as a
// "scroll something on this screen" fallback when the runner doesn't
// hand us a testID — Maestro's `scroll: direction: DOWN` semantics.
static UIScrollView* findTopmostScrollView(UIView* root) {
    if (!root || root.hidden || root.alpha < 0.01) return nil;
    if ([root isKindOfClass:[UIScrollView class]]) {
        UIScrollView* sv = (UIScrollView*)root;
        // Skip degenerate scroll views (zero content size, hidden).
        if (sv.contentSize.height > sv.bounds.size.height || sv.contentSize.width > sv.bounds.size.width) {
            return sv;
        }
    }
    for (UIView* sub in [root.subviews reverseObjectEnumerator]) {
        UIScrollView* hit = findTopmostScrollView(sub);
        if (hit) return hit;
    }
    return nil;
}

// testID-less scroll: pick the deepest scrollable on screen, mirroring
// what a user would touch. Iterates windows in reverse so the most-
// recently-presented (modal/sheet) scroll view wins over the underlying.
static UIScrollView* findFirstVisibleScrollView() {
    for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow* win in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
            UIScrollView* sv = findTopmostScrollView(win);
            if (sv) return sv;
        }
    }
    return nil;
}

static UIScrollView* resolveScrollTarget(NSString* tid) {
    if (tid.length > 0) {
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (view) {
            return [view isKindOfClass:[UIScrollView class]] ? (UIScrollView*)view : findEnclosingScrollView(view);
        }
    }
    return findFirstVisibleScrollView();
}

static bool scrollImpl(NSString* tid, NSString* direction, double distance) {
    __block bool ok = false;
    void (^block)(void) = ^{
        UIScrollView* sv = resolveScrollTarget(tid);
        if (!sv) return;
        CGPoint offset = sv.contentOffset;
        CGFloat dx = 0, dy = 0;
        NSString* d = [direction lowercaseString];
        if ([d isEqualToString:@"up"]) dy = -distance;
        else if ([d isEqualToString:@"down"]) dy = distance;
        else if ([d isEqualToString:@"left"]) dx = -distance;
        else if ([d isEqualToString:@"right"]) dx = distance;
        offset.x = MAX(-sv.contentInset.left, MIN(offset.x + dx, sv.contentSize.width - sv.bounds.size.width + sv.contentInset.right));
        offset.y = MAX(-sv.contentInset.top, MIN(offset.y + dy, sv.contentSize.height - sv.bounds.size.height + sv.contentInset.bottom));
        [sv setContentOffset:offset animated:NO];
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::scroll(const std::string& testID, const std::string& direction, double distance) {
    return scrollImpl([NSString stringWithUTF8String:testID.c_str()],
                      [NSString stringWithUTF8String:direction.c_str()],
                      distance);
}

bool EnnioRuntimeHelper::swipe(const std::string& testID, const std::string& direction, double distance) {
    return scrollImpl([NSString stringWithUTF8String:testID.c_str()],
                      [NSString stringWithUTF8String:direction.c_str()],
                      distance);
}

bool EnnioRuntimeHelper::scrollTo(const std::string& scrollViewTestID, const std::string& elementTestID) {
    NSString* svId = [NSString stringWithUTF8String:scrollViewTestID.c_str()];
    NSString* elId = [NSString stringWithUTF8String:elementTestID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* svView = findViewByTestIDInAllWindows(svId);
        UIView* elView = findViewByTestIDInAllWindows(elId);
        if (!svView || !elView) return;
        UIScrollView* sv = [svView isKindOfClass:[UIScrollView class]] ? (UIScrollView*)svView : findEnclosingScrollView(svView);
        if (!sv) return;
        CGRect frame = [elView convertRect:elView.bounds toView:sv];
        [sv scrollRectToVisible:frame animated:NO];
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

// Plain explicit recursion. The previous implementation used a
// self-referential block (`__block find = …; findWeak = find;`) where
// the weak capture happened before assignment — if the block ran via a
// dispatched continuation before the assignment was observable on the
// executing thread, `findWeak` was nil and the recursion no-op'd.
static UITabBarController* findTabBarController(UIViewController* vc) {
    if (!vc) return nil;
    if ([vc isKindOfClass:[UITabBarController class]]) return (UITabBarController*)vc;
    for (UIViewController* child in vc.childViewControllers) {
        UITabBarController* found = findTabBarController(child);
        if (found) return found;
    }
    if (vc.presentedViewController) {
        return findTabBarController(vc.presentedViewController);
    }
    return nil;
}

bool EnnioRuntimeHelper::tapTabByName(const std::string& name) {
    NSString* needle = [NSString stringWithUTF8String:name.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in ((UIWindowScene*)scene).windows) {
                UITabBarController* tab = findTabBarController(win.rootViewController);
                if (!tab) continue;
                NSUInteger idx = 0;
                for (UIViewController* vc in tab.viewControllers) {
                    NSString* title = vc.tabBarItem.title.length > 0 ? vc.tabBarItem.title : vc.title;
                    if (title && [title compare:needle options:NSCaseInsensitiveSearch] == NSOrderedSame) {
                        // expo-router top-level routes (e.g. /product/[id],
                        // /orders, /checkout) push over the tab bar via the
                        // root Stack. A tab tap while one of those is on
                        // top would only swap tabs *behind* the pushed VC —
                        // visually nothing changes. Walk up the parent
                        // chain and pop any nav stack that has more than
                        // its root so the tab controller becomes visible.
                        UIViewController* ancestor = tab.parentViewController;
                        while (ancestor) {
                            if ([ancestor isKindOfClass:[UINavigationController class]]) {
                                UINavigationController* nav = (UINavigationController*)ancestor;
                                if (nav.viewControllers.count > 1) {
                                    [nav popToRootViewControllerAnimated:NO];
                                }
                            }
                            ancestor = ancestor.parentViewController;
                        }
                        // Programmatic setSelectedIndex: never fires the
                        // delegates. RNScreens emits onNativeFocusChange
                        // from shouldSelect — so call shouldSelect first to
                        // give expo-router NativeTabs a chance to update
                        // its React state. Then set selectedIndex so the
                        // native tabbar visually switches even in
                        // controlled mode (React state will catch up via
                        // the emitted event). Finally call didSelect so
                        // RNScreens' stack-push child of the destination
                        // tab is shown rather than the previous tab's
                        // stale content.
                        if ([tab.delegate respondsToSelector:@selector(tabBarController:shouldSelectViewController:)]) {
                            [tab.delegate tabBarController:tab shouldSelectViewController:vc];
                        }
                        tab.selectedIndex = idx;
                        if ([tab.delegate respondsToSelector:@selector(tabBarController:didSelectViewController:)]) {
                            [tab.delegate tabBarController:tab didSelectViewController:vc];
                        }
                        ok = true;
                        return;
                    }
                    idx++;
                }
            }
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::tapTab(int index) {
    __block bool ok = false;
    void (^block)(void) = ^{
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in ((UIWindowScene*)scene).windows) {
                UITabBarController* tab = findTabBarController(win.rootViewController);
                if (tab && index >= 0 && index < (int)tab.viewControllers.count) {
                    UIViewController* vc = tab.viewControllers[index];
                    if ([tab.delegate respondsToSelector:@selector(tabBarController:shouldSelectViewController:)]) {
                        [tab.delegate tabBarController:tab shouldSelectViewController:vc];
                    }
                    tab.selectedIndex = (NSUInteger)index;
                    if ([tab.delegate respondsToSelector:@selector(tabBarController:didSelectViewController:)]) {
                        [tab.delegate tabBarController:tab didSelectViewController:vc];
                    }
                    ok = true;
                    return;
                }
            }
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

// DFS the VC hierarchy looking for the deepest UINavigationController
// whose stack has > 1 controllers. react-native-screens nests its
// RNSScreenStackHostController several levels deep, so we can't just walk
// up from the topmost VC — we have to scan everything.
static UINavigationController* findPoppableNavController(UIViewController* root) {
    if (!root) return nil;
    NSMutableArray<UIViewController*>* queue = [NSMutableArray arrayWithObject:root];
    UINavigationController* deepest = nil;
    while (queue.count > 0) {
        UIViewController* vc = queue.firstObject;
        [queue removeObjectAtIndex:0];
        if ([vc isKindOfClass:[UINavigationController class]]) {
            UINavigationController* nav = (UINavigationController*)vc;
            if (nav.viewControllers.count > 1) {
                deepest = nav;  // Keep the last (deepest) match.
            }
        }
        for (UIViewController* child in vc.childViewControllers) [queue addObject:child];
        if (vc.presentedViewController) [queue addObject:vc.presentedViewController];
    }
    return deepest;
}

std::tuple<double, double, double, double>
EnnioRuntimeHelper::getReadyCoord(const std::string& testID, int maxWaitMs) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    NSTimeInterval start = CACurrentMediaTime();
    NSTimeInterval deadline = start + maxWaitMs / 1000.0;

    while (true) {
        __block double rx = 0, ry = 0, rw = 0, rh = 0;
        __block BOOL ready = NO;

        void (^block)(void) = ^{
            UIView* view = findViewByTestIDInAllWindows(tid);
            if (!view || !view.window) return;
            UIWindow* win = view.window;

            // Chain: every ancestor must accept hits. iOS sets
            // userInteractionEnabled = NO on UIPresentationController's
            // containerView only DURING a present/dismiss transition,
            // so checking the chain catches mid-transition blocking
            // without falsely rejecting idle screens. Hidden view ⇒
            // hit-test always misses. Alpha is intentionally NOT
            // checked: Modal fade-in starts at alpha 0 yet iOS still
            // delivers the touch to the layer.
            for (UIView* v = view; v != nil; v = v.superview) {
                if (!v.userInteractionEnabled) return;
                if (v.hidden) return;
            }

            // No alert-level window above us. UIAlertController takes
            // a window at UIWindowLevelAlert; HID lands on the alert,
            // not on our target. Wait for it to clear.
            for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
                if (![scene isKindOfClass:[UIWindowScene class]]) continue;
                for (UIWindow* w in ((UIWindowScene*)scene).windows) {
                    if (w == win) continue;
                    if (w.hidden) continue;
                    if (w.windowLevel >= UIWindowLevelAlert) return;
                }
            }

            CGRect inWindow = [view convertRect:view.bounds toView:win];
            rx = inWindow.origin.x;
            ry = inWindow.origin.y;
            rw = inWindow.size.width;
            rh = inWindow.size.height;
            if (rw > 0 && rh > 0) ready = YES;
        };

        if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
        if (ready) return {rx, ry, rw, rh};
        if (CACurrentMediaTime() >= deadline) return {0, 0, 0, 0};
        [NSThread sleepForTimeInterval:0.020];
    }
}

// Build a synthesized UITouch the recognizer / responder chain accepts.
// Phase is settable on the touch directly via private KVC; window/view
// fields are required so RN's touch handlers route the event correctly.
static UITouch* makeSynthTouch(UIView* view, UIWindow* window, CGPoint location, UITouchPhase phase) {
    UITouch* touch = [[UITouch alloc] init];
    if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
        [touch _setLocationInWindow:location resetPrevious:NO];
    } else {
        [touch setValue:[NSValue valueWithCGPoint:location] forKey:@"locationInWindow"];
    }
    [touch setValue:@(phase) forKey:@"phase"];
    [touch setValue:window forKey:@"window"];
    [touch setValue:view forKey:@"view"];
    [touch setValue:@(1) forKey:@"tapCount"];
    [touch setValue:@([[NSProcessInfo processInfo] systemUptime]) forKey:@"timestamp"];
    if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) {
        [touch _setIsFirstTouchForView:YES];
    }
    return touch;
}

// Recurse through a view's subtree collecting recognizers. RNGH
// attaches its handler's recognizer (RNNativeViewGestureRecognizer /
// RNDummyGestureRecognizer) to the host view itself or a hidden child,
// so a superview-only walk misses it.
static void appendRecognizersFromSubtree(UIView* view, NSMutableArray* out, NSHashTable* seen) {
    // NSHashTable.weakObjectsHashTable holds zeroing weak refs. If a
    // descendant view dealloc's mid-walk the entry self-clears, so
    // there's no dangling-pointer hazard the prior NSValue-based set had.
    if (!view || [seen containsObject:view]) return;
    [seen addObject:view];
    for (UIGestureRecognizer* r in view.gestureRecognizers) {
        if (r.enabled) [out addObject:r];
    }
    for (UIView* sub in view.subviews) {
        appendRecognizersFromSubtree(sub, out, seen);
    }
}

// Walk view's own + ancestors' + descendants' recognizers. Deepest-first
// (descendants then self then ancestors) so the inner gesture-handler's
// recogniser wins gesture-coordinator ties.
static NSArray<UIGestureRecognizer*>* collectRecognizersDeepestFirst(UIView* view) {
    NSMutableArray* out = [NSMutableArray array];
    NSHashTable* seen = [NSHashTable weakObjectsHashTable];
    appendRecognizersFromSubtree(view, out, seen);
    // Then ancestors.
    for (UIView* v = view.superview; v != nil; v = v.superview) {
        for (UIGestureRecognizer* r in v.gestureRecognizers) {
            if (r.enabled) [out addObject:r];
        }
    }
    return out;
}

bool EnnioRuntimeHelper::fireTapByTestID(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;

    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view || !view.window) return;
        UIWindow* window = view.window;
        CGPoint center = CGPointMake(CGRectGetMidX(view.bounds), CGRectGetMidY(view.bounds));
        CGPoint inWindow = [view convertPoint:center toView:window];
        NSLog(@"[Ennio][fireTap] testID=%@ class=%@ window=YES", tid, NSStringFromClass([view class]));

        // Path 1: nearest enabled UIControl ancestor → fire
        // touchUpInside actions. Covers UIButton, UISwitch, UISlider,
        // and RNGestureHandlerButton (RNGH BaseButton / pressto) —
        // RNGH does register UIControl actions even though its public
        // path is the gesture handler module. If allTargets is empty
        // for this UIControl, fall through (some custom UIControls
        // don't use action targets).
        for (UIView* cursor = view; cursor != nil; cursor = cursor.superview) {
            if (![cursor isKindOfClass:[UIControl class]]) continue;
            UIControl* ctrl = (UIControl*)cursor;
            if (!ctrl.enabled) continue;
            NSSet* targets = [ctrl allTargets];
            if (targets.count == 0) continue;
            NSLog(@"[Ennio][fireTap] sendActions on %@ targets=%lu",
                  NSStringFromClass([ctrl class]), (unsigned long)targets.count);
            [ctrl sendActionsForControlEvents:UIControlEventTouchUpInside];
            ok = true;
            return;
        }

        // Path 2: drive every gesture recogniser in the view +
        // ancestor chain by hand. RCTSurfaceTouchHandler (the
        // RCTRootView-level recogniser RN uses to feed its responder
        // system) recognises a tap → JS sees onResponderRelease →
        // Pressability fires onPress. RNNativeViewGestureRecognizer
        // (RNGH BaseButton/pressto) recognises a tap → JS sees
        // onActivated → RNGH BaseButton fires onPress. Bypasses
        // UIWindow.sendEvent so UIPresentationController's
        // mid-transition gating can't drop the touch. Calling
        // touchesBegan:/touchesEnded: directly on the recogniser is
        // the supported entry point — UIKit dispatches there itself
        // during normal events.
        NSArray<UIGestureRecognizer*>* recognizers = collectRecognizersDeepestFirst(view);
        NSLog(@"[Ennio][fireTap] recognizers count=%lu", (unsigned long)recognizers.count);
        for (UIGestureRecognizer* r in recognizers) {
            NSLog(@"[Ennio][fireTap]   - %@ enabled=%d", NSStringFromClass([r class]), r.enabled);
        }
        if (recognizers.count > 0) {
            UIApplication* app = [UIApplication sharedApplication];
            UIEvent* event = [app respondsToSelector:@selector(_touchesEvent)] ? [app _touchesEvent] : nil;

            UITouch* touchBegan = makeSynthTouch(view, window, inWindow, UITouchPhaseBegan);
            NSSet* setBegan = [NSSet setWithObject:touchBegan];
            for (UIGestureRecognizer* r in recognizers) {
                @try { [r touchesBegan:setBegan withEvent:event]; }
                @catch (NSException* e) { NSLog(@"[Ennio] touchesBegan throw: %@", e.reason); }
            }
            // Spin the runloop one tick so recognisers can transition
            // from Possible → Began (some need a frame to commit
            // intermediate state before they accept Ended).
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.020]];

            UITouch* touchEnded = makeSynthTouch(view, window, inWindow, UITouchPhaseEnded);
            NSSet* setEnded = [NSSet setWithObject:touchEnded];
            for (UIGestureRecognizer* r in recognizers) {
                @try { [r touchesEnded:setEnded withEvent:event]; }
                @catch (NSException* e) { NSLog(@"[Ennio] touchesEnded throw: %@", e.reason); }
            }
            ok = true;
            return;
        }

        // Path 3: accessibilityActivate. Last resort because it only
        // fires onPress for views that explicitly opt in (Pressable
        // with accessibilityRole="button"). For the rest it returns
        // YES but does nothing visible. Returning ok=true here is
        // best-effort; the caller's assertVisible/assertNotVisible will
        // catch a no-op.
        if ([view accessibilityActivate]) {
            ok = true;
            return;
        }
    };

    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::backGesture() {
    __block bool ok = false;
    void (^block)(void) = ^{
        // Walk every connected window. The poppable nav controller may
        // live in a window other than the keyWindow (e.g. modal sheet
        // hosted in its own UIWindow on newer iOS).
        UINavigationController* nav = nil;
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
                UINavigationController* candidate = findPoppableNavController(win.rootViewController);
                if (candidate) { nav = candidate; break; }
            }
            if (nav) break;
        }
        if (nav) {
            [nav popViewControllerAnimated:NO];
            ok = true;
            return;
        }
        // No nav stack to pop — fall back to dismissing whatever is
        // presented modally on top.
        UIViewController* top = topMostViewControllerForKeyWindow();
        if (top && top.presentingViewController) {
            [top.presentingViewController dismissViewControllerAnimated:NO completion:nil];
            ok = true;
            return;
        }
        NSLog(@"[Ennio] backGesture: no navigation stack to pop and no presented VC to dismiss");
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::hideKeyboard() {
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* fr = findFirstResponder();
        if (fr) { [fr resignFirstResponder]; ok = true; }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::tapAlertButton(const std::string& buttonText) {
    NSString* title = [NSString stringWithUTF8String:buttonText.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) return;
        for (UIAlertAction* action in alert.actions) {
            if ([action.title isEqualToString:title]) {
                invokeAlertAction(alert, action);
                ok = true;
                return;
            }
        }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::dismissAlert() {
    __block bool ok = false;
    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) return;
        UIAlertAction* pick = nil;
        for (NSString* preferred in @[@"Cancel", @"OK", @"Dismiss"]) {
            for (UIAlertAction* action in alert.actions) {
                if ([action.title isEqualToString:preferred]) { pick = action; break; }
            }
            if (pick) break;
        }
        if (!pick && alert.actions.count > 0) pick = alert.actions.firstObject;
        if (pick) { invokeAlertAction(alert, pick); ok = true; }
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::copyToClipboard(const std::string& text) {
    NSString* str = [NSString stringWithUTF8String:text.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        [UIPasteboard generalPasteboard].string = str;
        ok = true;
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return ok;
}

bool EnnioRuntimeHelper::pasteFromClipboard(const std::string& testID) {
    NSString* clip = [UIPasteboard generalPasteboard].string ?: @"";
    return typeText(testID, [clip UTF8String]);
}

std::string EnnioRuntimeHelper::getClipboardText() {
    __block std::string result;
    void (^block)(void) = ^{
        NSString* s = [UIPasteboard generalPasteboard].string;
        if (s) result = [s UTF8String];
    };
    if ([NSThread isMainThread]) block(); else dispatchSyncMainWithTimeout(block);
    return result;
}

} // namespace ennio

// Objective-C helper for setting the surface presenter
extern "C" void EnnioSetSurfacePresenter(RCTSurfacePresenter* presenter) {
    ennio::EnnioRuntimeHelper::getInstance().setSurfacePresenter((__bridge void*)presenter);
}

// Logging helper for C++ code
extern "C" void EnnioLogMessage(const char* message) {
    NSLog(@"%s", message);
}
