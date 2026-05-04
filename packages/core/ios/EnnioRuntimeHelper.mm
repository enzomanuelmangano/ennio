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

/**
 * Dispatch a block to the main thread with timeout.
 * Returns YES if completed, NO if timed out.
 * If already on main thread, executes immediately.
 */
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
static RCTSurfacePresenter* findSurfacePresenterInRuntime() {
    NSLog(@"[Ennio] Searching for surface presenter...");

    // Try to access through the app delegate
    UIApplication* app = [UIApplication sharedApplication];
    id appDelegate = app.delegate;

    NSLog(@"[Ennio] AppDelegate class: %@", NSStringFromClass([appDelegate class]));

    // Method 1: Try reactNativeFactory -> reactHost -> surfacePresenter (newer Expo pattern)
    SEL factorySel = NSSelectorFromString(@"reactNativeFactory");
    if ([appDelegate respondsToSelector:factorySel]) {
        #pragma clang diagnostic push
        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        id factory = [appDelegate performSelector:factorySel];
        #pragma clang diagnostic pop

        if (factory) {
            NSLog(@"[Ennio] Found reactNativeFactory: %@", NSStringFromClass([factory class]));

            // Try reactHost first
            SEL hostSel = NSSelectorFromString(@"reactHost");
            if ([factory respondsToSelector:hostSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                id host = [factory performSelector:hostSel];
                #pragma clang diagnostic pop

                if (host) {
                    NSLog(@"[Ennio] Found reactHost: %@", NSStringFromClass([host class]));

                    SEL presenterSel = NSSelectorFromString(@"surfacePresenter");
                    if ([host respondsToSelector:presenterSel]) {
                        #pragma clang diagnostic push
                        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                        id presenter = [host performSelector:presenterSel];
                        #pragma clang diagnostic pop

                        if (presenter) {
                            NSLog(@"[Ennio] Found surfacePresenter via host: %@", presenter);
                            return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
                        }
                    }
                }
            }

            // Try surfacePresenter directly on factory
            SEL presenterSel = NSSelectorFromString(@"surfacePresenter");
            if ([factory respondsToSelector:presenterSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                id presenter = [factory performSelector:presenterSel];
                #pragma clang diagnostic pop

                if (presenter) {
                    NSLog(@"[Ennio] Found surfacePresenter on factory: %@", presenter);
                    return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
                }
            }

            // Log available methods on factory for debugging
            NSLog(@"[Ennio] Factory methods:");
            unsigned int count;
            Method *methods = class_copyMethodList([factory class], &count);
            for (unsigned int i = 0; i < count && i < 20; i++) {
                NSLog(@"[Ennio]   - %@", NSStringFromSelector(method_getName(methods[i])));
            }
            free(methods);
        }
    }

    // Method 2: Search windows for RCTSurfaceHostingView
    NSLog(@"[Ennio] Searching windows for RCTSurfaceHostingView...");
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            for (UIWindow* window in windowScene.windows) {
                UIViewController* rootVC = window.rootViewController;
                if (rootVC && rootVC.view) {
                    // Look for RCTRootContentView or RCTSurfaceHostingView
                    for (UIView* subview in rootVC.view.subviews) {
                        NSString* className = NSStringFromClass([subview class]);
                        NSLog(@"[Ennio] Found view: %@", className);

                        if ([className containsString:@"RCTSurface"] ||
                            [className containsString:@"RCTRoot"]) {
                            // Try to get surface from this view
                            SEL surfaceSel = NSSelectorFromString(@"surface");
                            if ([subview respondsToSelector:surfaceSel]) {
                                #pragma clang diagnostic push
                                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                                id surface = [subview performSelector:surfaceSel];
                                #pragma clang diagnostic pop

                                if (surface) {
                                    SEL presenterSel = NSSelectorFromString(@"surfacePresenter");
                                    if ([surface respondsToSelector:presenterSel]) {
                                        #pragma clang diagnostic push
                                        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                                        id presenter = [surface performSelector:presenterSel];
                                        #pragma clang diagnostic pop

                                        if (presenter) {
                                            NSLog(@"[Ennio] Found surfacePresenter via view: %@", presenter);
                                            return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

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

// Helper to find the presented alert controller
static UIAlertController* findPresentedAlertController() {
    // Walk EVERY connected window, not just the key window. The XCTest
    // helper presents its own UIWindow when running, which can take key
    // status away from the user app — so the alert lives on a non-key
    // window and the old key-window-only lookup misses it entirely.
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
static BOOL synthesizeTouchAtViewCenter(UIView* view) {
    if (!view || !view.window) return NO;
    UIWindow* window = view.window;
    CGPoint center = CGPointMake(view.bounds.size.width / 2, view.bounds.size.height / 2);
    CGPoint locationInWindow = [view convertPoint:center toView:window];

    UIApplication* app = [UIApplication sharedApplication];
    UIEvent* event = nil;
    if ([app respondsToSelector:@selector(_touchesEvent)]) {
        event = [app _touchesEvent];
    }
    if (!event) return NO;

    UITouch* touch = [[UITouch alloc] init];
    if ([touch respondsToSelector:@selector(_setLocationInWindow:resetPrevious:)]) {
        [touch _setLocationInWindow:locationInWindow resetPrevious:NO];
    } else {
        [touch setValue:[NSValue valueWithCGPoint:locationInWindow] forKey:@"locationInWindow"];
    }
    [touch setValue:@(UITouchPhaseBegan) forKey:@"phase"];
    [touch setValue:window forKey:@"window"];
    [touch setValue:view forKey:@"view"];
    [touch setValue:@(1) forKey:@"tapCount"];
    NSTimeInterval beganAt = [[NSProcessInfo processInfo] systemUptime];
    [touch setValue:@(beganAt) forKey:@"timestamp"];
    if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) {
        [touch _setIsFirstTouchForView:YES];
    }

    @try {
        if ([event respondsToSelector:@selector(_clearTouches)]) {
            [event _clearTouches];
        }
        if ([event respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
            [event _addTouch:touch forDelayedDelivery:NO];
        }
        [app sendEvent:event];

        // Tiny runloop iteration so RN's touch handler registers Began
        // before Ended arrives. Too long and the runloop runs unrelated
        // timers; too short and Pressable's gesture system flags it as
        // touchCancelled. 30ms covers small Pressables (clear-X, switch
        // toggles) reliably while still feeling instantaneous.
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.030]];

        // Fresh UIEvent for the End phase. Reusing the Began event has
        // been observed to drop the second sendEvent on iOS 26 — the
        // touch handler dedupes by event hash and skips the second one.
        UIEvent* endEvent = [app respondsToSelector:@selector(_touchesEvent)]
            ? [app _touchesEvent] : event;
        [touch setValue:@(UITouchPhaseEnded) forKey:@"phase"];
        [touch setValue:@(beganAt + 0.030) forKey:@"timestamp"];
        if (endEvent != event) {
            if ([endEvent respondsToSelector:@selector(_clearTouches)]) {
                [endEvent _clearTouches];
            }
            if ([endEvent respondsToSelector:@selector(_addTouch:forDelayedDelivery:)]) {
                [endEvent _addTouch:touch forDelayedDelivery:NO];
            }
        }
        [app sendEvent:endEvent];
        return YES;
    } @catch (NSException* e) {
        NSLog(@"[Ennio] synthesizeTouchAtViewCenter: %@", e.reason);
        return NO;
    }
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
static BOOL fireActivation(UIView* view) {
    if (!view) return NO;

    // 1. Synthesized UITouch through UIApplication.sendEvent — best for
    //    RN Pressable / Touchable* on Fabric.
    if (synthesizeTouchAtViewCenter(view)) return YES;

    // 2. UIControl: sendActionsForControlEvents fires every connected target.
    if ([view isKindOfClass:[UIControl class]]) {
        UIControl* ctrl = (UIControl*)view;
        if (ctrl.enabled) {
            [ctrl sendActionsForControlEvents:UIControlEventTouchUpInside];
            return YES;
        }
    }

    // 3. accessibilityActivate (native controls, VoiceOver-wired widgets).
    if ([view accessibilityActivate]) return YES;

    // 4. Tap gesture recognizer fallback.
    for (UIGestureRecognizer* gr in view.gestureRecognizers) {
        if (!gr.enabled) continue;
        if (![gr isKindOfClass:[UITapGestureRecognizer class]]) continue;
        @try {
            NSArray* targets = [gr valueForKey:@"_targets"];
            for (id target in targets) {
                id realTarget = [target valueForKey:@"_target"];
                NSString* actionName = [target valueForKey:@"_action"];
                if (!realTarget || !actionName) continue;
                SEL action = NSSelectorFromString(actionName);
                if (![realTarget respondsToSelector:action]) continue;
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [realTarget performSelector:action withObject:gr];
                #pragma clang diagnostic pop
            }
            return YES;
        } @catch (NSException* e) {
            NSLog(@"[Ennio] fireActivation: gesture-recognizer KVC failed: %@", e.reason);
        }
    }
    return NO;
}

// Recursively search the view tree for a UIView whose accessibilityIdentifier
// matches the testID. Hidden / size-zero views skipped because they're not
// interactable.
static UIView* findViewByTestID(UIView* root, NSString* testID) {
    if (!root || root.hidden || root.alpha < 0.01) return nil;
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

bool EnnioRuntimeHelper::tap(const std::string& testID) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) {
            NSLog(@"[Ennio] tap: testID '%@' not found in view tree", tid);
            return;
        }
        if (fireActivation(view)) { ok = true; return; }
        NSMutableArray* queue = [NSMutableArray arrayWithArray:view.subviews];
        while (queue.count > 0) {
            UIView* next = queue.firstObject;
            [queue removeObjectAtIndex:0];
            if (fireActivation(next)) { ok = true; return; }
            [queue addObjectsFromArray:next.subviews];
        }
        UIView* cursor = view.superview;
        while (cursor) {
            if (fireActivation(cursor)) { ok = true; return; }
            cursor = cursor.superview;
        }
        // Last resort: synthesize a tap at the view's centre via private
        // UITouch / UIApplication selectors. RN Fabric's
        // RCTViewComponentView intercepts touches through its
        // touchesBegan/Ended overrides — the only path that actually fires
        // Pressable onPress without a real HID event.
        if (synthesizeTouchAtViewCenter(view)) { ok = true; return; }
        NSLog(@"[Ennio] tap: '%@' has no activation path (class=%@, traits=0x%llx, isAccessibilityElement=%d)",
              tid, NSStringFromClass([view class]), (unsigned long long)view.accessibilityTraits, view.isAccessibilityElement);
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
static UIView* findLabelMatch(UIView* root, NSString* text, UIView* best) {
    if (!root || root.hidden || root.alpha < 0.01) return best;
    NSString* label = root.accessibilityLabel;
    BOOL matches = NO;
    if (label) {
        if ([label isEqualToString:text]) {
            matches = YES;
        } else if ([label rangeOfString:text options:NSCaseInsensitiveSearch].location != NSNotFound) {
            // CONTAINS, but require the match to be a whole word so "Home"
            // doesn't match "Welcome Home". Word boundaries: start of
            // string, end of string, or non-letter neighbour.
            NSRange r = [label rangeOfString:text options:NSCaseInsensitiveSearch];
            BOOL leftOk = r.location == 0 || ![[NSCharacterSet letterCharacterSet] characterIsMember:[label characterAtIndex:r.location - 1]];
            BOOL rightOk = r.location + r.length == label.length || ![[NSCharacterSet letterCharacterSet] characterIsMember:[label characterAtIndex:r.location + r.length]];
            matches = leftOk && rightOk;
        }
    }
    if (matches) {
        if (!best || root.bounds.size.width * root.bounds.size.height
                     < best.bounds.size.width * best.bounds.size.height) {
            best = root;
        }
    }
    for (UIView* sub in root.subviews) {
        best = findLabelMatch(sub, text, best);
    }
    return best;
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

bool EnnioRuntimeHelper::typeText(const std::string& testID, const std::string& text) {
    NSString* tid = [NSString stringWithUTF8String:testID.c_str()];
    NSString* str = [NSString stringWithUTF8String:text.c_str()];
    __block bool ok = false;
    void (^block)(void) = ^{
        UIView* view = findViewByTestIDInAllWindows(tid);
        if (!view) return;
        // RN's TextInput maps to RCTBackedTextInputView, which conforms
        // to UITextInput. insertText: at the current selection appends
        // and fires the change delegate so React's onChangeText runs.
        if ([view conformsToProtocol:@protocol(UITextInput)]) {
            id<UITextInput> input = (id<UITextInput>)view;
            if (![view isFirstResponder]) [view becomeFirstResponder];
            [input insertText:str];
            ok = true;
            return;
        }
        // RN sometimes wraps the actual UITextField a level deeper.
        for (UIView* sub in view.subviews) {
            if ([sub conformsToProtocol:@protocol(UITextInput)]) {
                if (![sub isFirstResponder]) [sub becomeFirstResponder];
                [(id<UITextInput>)sub insertText:str];
                ok = true;
                return;
            }
        }
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

static bool scrollImpl(NSString* tid, NSString* direction, double distance) {
    __block bool ok = false;
    void (^block)(void) = ^{
        UIScrollView* sv = nil;
        if (tid.length > 0) {
            UIView* view = findViewByTestIDInAllWindows(tid);
            if (view) {
                sv = [view isKindOfClass:[UIScrollView class]] ? (UIScrollView*)view : findEnclosingScrollView(view);
            }
        }
        if (!sv) {
            // testID-less scroll: pick the deepest scrollable view on
            // screen and scroll it. Mirrors what the user would do.
            for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
                if (![scene isKindOfClass:[UIWindowScene class]]) continue;
                for (UIWindow* win in [((UIWindowScene*)scene).windows reverseObjectEnumerator]) {
                    sv = findTopmostScrollView(win);
                    if (sv) break;
                }
                if (sv) break;
            }
        }
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

bool EnnioRuntimeHelper::tapTab(int index) {
    __block bool ok = false;
    void (^block)(void) = ^{
        // Walk every window for a UITabBarController, pick the index.
        for (UIScene* scene in [UIApplication sharedApplication].connectedScenes) {
            if (![scene isKindOfClass:[UIWindowScene class]]) continue;
            for (UIWindow* win in ((UIWindowScene*)scene).windows) {
                UIViewController* root = win.rootViewController;
                __block UITabBarController* tab = nil;
                void (^find)(UIViewController*) = ^(UIViewController* vc) {};
                __block __weak void (^findWeak)(UIViewController*) = nil;
                find = ^(UIViewController* vc) {
                    if (!vc || tab) return;
                    if ([vc isKindOfClass:[UITabBarController class]]) { tab = (UITabBarController*)vc; return; }
                    for (UIViewController* child in vc.childViewControllers) findWeak(child);
                    if (vc.presentedViewController) findWeak(vc.presentedViewController);
                };
                findWeak = find;
                find(root);
                if (tab && index >= 0 && index < (int)tab.viewControllers.count) {
                    tab.selectedIndex = (NSUInteger)index;
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
