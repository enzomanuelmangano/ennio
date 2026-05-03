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
#import <unistd.h>

// Private UITouch methods we need to call
@interface UITouch (EnnioPrivate)
- (void)setView:(UIView *)view;
- (void)setWindow:(UIWindow *)window;
- (void)setPhase:(UITouchPhase)phase;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)_setIsFirstTouchForView:(BOOL)isFirst;
@end

// Private UIEvent methods
@interface UIEvent (EnnioPrivate)
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_clearTouches;
@end

// Private application methods for creating touch events
@interface UIApplication (EnnioPrivate)
- (UIEvent *)_touchesEvent;
@end

// Helper to find a view by accessibility identifier recursively
static UIView* findViewByAccessibilityIdentifier(UIView* root, NSString* identifier) {
    if ([root.accessibilityIdentifier isEqualToString:identifier]) {
        return root;
    }

    for (UIView* subview in root.subviews) {
        UIView* found = findViewByAccessibilityIdentifier(subview, identifier);
        if (found) {
            return found;
        }
    }

    return nil;
}

// Helper to find a view by accessibility label (text) recursively
// This is used for native iOS elements like tab bars that aren't in shadow tree
static UIView* findViewByAccessibilityLabel(UIView* root, NSString* label) {
    // Skip debugging overlays
    NSString* className = NSStringFromClass([root class]);
    if ([className containsString:@"DebuggingOverlay"] ||
        [className containsString:@"DebugOverlay"] ||
        [className containsString:@"DevMenu"]) {
        return nil;
    }

    // Check this view's accessibilityLabel
    if (root.accessibilityLabel && [root.accessibilityLabel isEqualToString:label]) {
        // Prefer buttons/tappable elements
        if ([root isKindOfClass:[UIButton class]] ||
            [root isKindOfClass:[UIControl class]] ||
            (root.accessibilityTraits & UIAccessibilityTraitButton) != 0) {
            NSLog(@"[Ennio] findViewByAccessibilityLabel: Found button/control '%@' class=%@",
                  label, className);
            return root;
        }
    }

    // Check children first (depth-first)
    for (UIView* subview in root.subviews) {
        UIView* found = findViewByAccessibilityLabel(subview, label);
        if (found) {
            return found;
        }
    }

    // If no button found in children, accept any matching accessible element
    if (root.accessibilityLabel && [root.accessibilityLabel isEqualToString:label]) {
        if (root.isAccessibilityElement) {
            NSLog(@"[Ennio] findViewByAccessibilityLabel: Found accessible '%@' class=%@",
                  label, className);
            return root;
        }
    }

    return nil;
}

// Find ALL views with matching accessibility label (for debugging)
static void findAllViewsByAccessibilityLabel(UIView* root, NSString* label, NSMutableArray<UIView*>* results) {
    NSString* className = NSStringFromClass([root class]);
    if ([className containsString:@"DebuggingOverlay"]) {
        return;
    }

    if (root.accessibilityLabel && [root.accessibilityLabel isEqualToString:label]) {
        [results addObject:root];
    }

    for (UIView* subview in root.subviews) {
        findAllViewsByAccessibilityLabel(subview, label, results);
    }
}

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

// Helper to find the topmost window at a given point
static UIWindow* findWindowAtPoint(CGPoint point) {
    // Get all windows sorted by windowLevel (highest first)
    NSMutableArray<UIWindow*>* allWindows = [NSMutableArray array];

    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            [allWindows addObjectsFromArray:windowScene.windows];
        }
    }

    NSLog(@"[Ennio] findWindowAtPoint: Found %lu windows total", (unsigned long)allWindows.count);

    // Sort by window level (highest first) and check if point is in window
    [allWindows sortUsingComparator:^NSComparisonResult(UIWindow* w1, UIWindow* w2) {
        if (w1.windowLevel > w2.windowLevel) return NSOrderedAscending;
        if (w1.windowLevel < w2.windowLevel) return NSOrderedDescending;
        return NSOrderedSame;
    }];

    for (UIWindow* window in allWindows) {
        NSLog(@"[Ennio] findWindowAtPoint: Checking window %@ (level: %.0f, hidden: %d, alpha: %.1f)",
              NSStringFromClass([window class]), window.windowLevel, window.isHidden, window.alpha);

        if (!window.isHidden && window.alpha > 0) {
            UIView* hitView = [window hitTest:point withEvent:nil];
            if (hitView && hitView != window) {
                NSLog(@"[Ennio] findWindowAtPoint: Using window with hitView %@",
                      NSStringFromClass([hitView class]));
                return window;
            }
        }
    }

    // Fallback to key window
    for (UIWindow* window in allWindows) {
        if (window.isKeyWindow) {
            NSLog(@"[Ennio] findWindowAtPoint: Falling back to key window");
            return window;
        }
    }

    return nil;
}

// Helper to find key window (deprecated, use findWindowAtPoint)
static UIWindow* findKeyWindow(void) {
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            for (UIWindow* window in windowScene.windows) {
                if (window.isKeyWindow) {
                    return window;
                }
            }
        }
    }
    return nil;
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

            // First try cached presenter from swizzling
            if (surfacePresenter_) {
                presenter = (__bridge RCTSurfacePresenter*)surfacePresenter_;
                NSLog(@"[Ennio] Using cached surfacePresenter: %@", presenter);
            }

            // If no cached, try runtime search
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

// Helper to find the RCTSurfaceTouchHandler gesture recognizer on a view hierarchy
static UIGestureRecognizer* findSurfaceTouchHandler(UIView* view) {
    UIView* searchView = view;
    while (searchView) {
        for (UIGestureRecognizer* gr in searchView.gestureRecognizers) {
            NSString* grClass = NSStringFromClass([gr class]);
            if ([grClass containsString:@"SurfaceTouchHandler"] ||
                [grClass containsString:@"RCTTouchHandler"]) {
                return gr;
            }
        }
        searchView = searchView.superview;
    }
    return nil;
}

// Helper to check if a view is a debugging overlay that should be skipped
static BOOL isDebuggingOverlay(UIView* view) {
    NSString* className = NSStringFromClass([view class]);
    return [className containsString:@"DebuggingOverlay"] ||
           [className containsString:@"DebugOverlay"] ||
           [className containsString:@"DevMenu"];
}

// Helper to find the actual tappable view, skipping debugging overlays
static UIView* findTappableViewAtPoint(UIWindow* window, CGPoint point) {
    // First, do a normal hit test
    UIView* hitView = [window hitTest:point withEvent:nil];
    if (!hitView) return nil;

    // If we hit a debugging overlay, search for the actual content beneath it
    if (isDebuggingOverlay(hitView) || isDebuggingOverlay(hitView.superview)) {
        NSLog(@"[Ennio] findTappableViewAtPoint: Skipping debugging overlay %@",
              NSStringFromClass([hitView class]));

        // Walk up to find the parent that contains non-debugging children
        UIView* container = hitView.superview;
        while (container && container != window) {
            // Look at siblings of the debugging overlay
            NSArray* siblings = container.subviews;
            for (UIView* sibling in [siblings reverseObjectEnumerator]) {
                if (!isDebuggingOverlay(sibling) && sibling != hitView) {
                    // Try hit test on this sibling
                    CGPoint siblingPoint = [container convertPoint:point toView:sibling];
                    UIView* siblingHit = [sibling hitTest:siblingPoint withEvent:nil];
                    if (siblingHit && !isDebuggingOverlay(siblingHit)) {
                        NSLog(@"[Ennio] findTappableViewAtPoint: Found sibling hit: %@",
                              NSStringFromClass([siblingHit class]));
                        return siblingHit;
                    }
                }
            }
            container = container.superview;
        }

        // Couldn't find non-debugging view, return nil
        NSLog(@"[Ennio] findTappableViewAtPoint: No non-debugging view found");
        return nil;
    }

    return hitView;
}

bool EnnioRuntimeHelper::performTap(float x, float y) {
    __block bool success = false;

    void (^tapBlock)(void) = ^{
        CGPoint point = CGPointMake(x, y);
        NSLog(@"[Ennio] performTap: Tapping at (%.1f, %.1f)", x, y);

        // Find the window that contains the view at this point (handles modals)
        UIWindow* targetWindow = findWindowAtPoint(point);
        if (!targetWindow) {
            NSLog(@"[Ennio] performTap: No window found at point");
            success = false;
            return;
        }

        NSLog(@"[Ennio] performTap: Using window %@ (level %.0f)",
              NSStringFromClass([targetWindow class]), targetWindow.windowLevel);

        // Find the target view at this point, skipping debugging overlays
        UIView* hitView = findTappableViewAtPoint(targetWindow, point);
        if (!hitView) {
            NSLog(@"[Ennio] performTap: No view at point (after skipping debugging overlays)");
            success = false;
            return;
        }

        NSLog(@"[Ennio] performTap: Hit view %@", NSStringFromClass([hitView class]));

        // Try Method 1: Use accessibilityActivate if available
        // This is the most reliable way to trigger onPress in React Native
        UIView* activatableView = hitView;
        while (activatableView && activatableView != targetWindow) {
            // Check if this view is accessible and can be activated
            if (activatableView.isAccessibilityElement ||
                activatableView.accessibilityTraits != UIAccessibilityTraitNone) {

                NSLog(@"[Ennio] performTap: Found accessible view: %@ (traits: %llu, identifier: %@)",
                      NSStringFromClass([activatableView class]),
                      (unsigned long long)activatableView.accessibilityTraits,
                      activatableView.accessibilityIdentifier ?: @"nil");

                // Try accessibility activate
                if ([activatableView accessibilityActivate]) {
                    NSLog(@"[Ennio] performTap: accessibilityActivate succeeded!");
                    success = true;
                    return;
                }
            }
            activatableView = activatableView.superview;
        }

        NSLog(@"[Ennio] performTap: accessibilityActivate didn't work, trying UIControl");

        // Try Method 2: For native UIControl (buttons, tab bar items), send control event
        UIView* controlView = hitView;
        while (controlView && controlView != targetWindow) {
            if ([controlView isKindOfClass:[UIControl class]]) {
                UIControl* control = (UIControl*)controlView;
                NSLog(@"[Ennio] performTap: Found UIControl: %@, sending touch event",
                      NSStringFromClass([control class]));
                [control sendActionsForControlEvents:UIControlEventTouchUpInside];
                success = true;
                return;
            }
            controlView = controlView.superview;
        }

        NSLog(@"[Ennio] performTap: No UIControl found, trying touch handler");

        // Try Method 3: Find the RCTSurfaceTouchHandler and call its touch methods directly
        UIGestureRecognizer* touchHandler = findSurfaceTouchHandler(hitView);
        if (touchHandler) {
            NSLog(@"[Ennio] performTap: Found touch handler: %@", NSStringFromClass([touchHandler class]));

            // For RCTSurfaceTouchHandler, we need to simulate touches through it
            // The touch handler expects to receive touches from the window
            // We'll create synthetic touches and send them through the gesture recognizer

            UITouch* touch = [[UITouch alloc] init];
            NSTimeInterval timestamp = [[NSProcessInfo processInfo] systemUptime];

            // Find the view that the touch handler is attached to (usually the surface view)
            UIView* touchHandlerView = touchHandler.view;
            if (!touchHandlerView) {
                touchHandlerView = hitView;
            }

            // Set up touch for began phase
            [touch setWindow:targetWindow];
            [touch setView:touchHandlerView];  // Use the touch handler's view
            [touch setPhase:UITouchPhaseBegan];
            [touch setTapCount:1];
            [touch _setLocationInWindow:point resetPrevious:YES];
            [touch setTimestamp:timestamp];
            [touch _setIsFirstTouchForView:YES];

            // Create touch set
            NSSet<UITouch*>* touches = [NSSet setWithObject:touch];

            // Get the application's touch event
            UIApplication* app = [UIApplication sharedApplication];
            UIEvent* event = [app _touchesEvent];
            [event _clearTouches];
            [event _addTouch:touch forDelayedDelivery:NO];

            NSLog(@"[Ennio] performTap: Calling touchesBegan on touch handler");

            // Call touchesBegan directly on the gesture recognizer
            [touchHandler touchesBegan:touches withEvent:event];

            // Wait a bit for processing
            usleep(60000); // 60ms

            // Update touch for ended phase
            [touch setPhase:UITouchPhaseEnded];
            [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
            [touch _setLocationInWindow:point resetPrevious:NO];

            [event _clearTouches];
            [event _addTouch:touch forDelayedDelivery:NO];

            NSLog(@"[Ennio] performTap: Calling touchesEnded on touch handler");

            // Call touchesEnded directly on the gesture recognizer
            [touchHandler touchesEnded:touches withEvent:event];

            success = true;
            return;
        }

        NSLog(@"[Ennio] performTap: No touch handler found, falling back to synthetic touch event");

        // Try Method 4: Fall back to synthetic UITouch via sendEvent (original approach)
        UIView* targetView = hitView;

        // Walk up to find a view with gesture recognizers
        UIView* searchView = hitView;
        while (searchView && searchView != targetWindow) {
            if (searchView.gestureRecognizers.count > 0) {
                targetView = searchView;
                break;
            }
            searchView = searchView.superview;
        }

        UITouch* touch = [[UITouch alloc] init];
        NSTimeInterval timestamp = [[NSProcessInfo processInfo] systemUptime];

        [touch setWindow:targetWindow];
        [touch setView:targetView];
        [touch setPhase:UITouchPhaseBegan];
        [touch setTapCount:1];
        [touch _setLocationInWindow:point resetPrevious:YES];
        [touch setTimestamp:timestamp];
        [touch _setIsFirstTouchForView:YES];

        UIApplication* app = [UIApplication sharedApplication];
        UIEvent* event = [app _touchesEvent];
        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];

        [app sendEvent:event];

        usleep(50000); // 50ms

        [touch setPhase:UITouchPhaseEnded];
        [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
        [touch _setLocationInWindow:point resetPrevious:NO];

        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];

        [app sendEvent:event];

        success = true;
    };

    // Execute on main queue
    if ([NSThread isMainThread]) {
        tapBlock();
    } else {
        dispatchSyncMainWithTimeout(tapBlock);
    }

    return success;
}

bool EnnioRuntimeHelper::performTapByTestID(const std::string& testID) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];

    void (^tapBlock)(void) = ^{
        // Find the key window
        UIWindow* keyWindow = nil;
        for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
            if ([scene isKindOfClass:[UIWindowScene class]]) {
                UIWindowScene* windowScene = (UIWindowScene*)scene;
                for (UIWindow* window in windowScene.windows) {
                    if (window.isKeyWindow) {
                        keyWindow = window;
                        break;
                    }
                }
            }
            if (keyWindow) break;
        }

        if (!keyWindow) {
            NSLog(@"[Ennio] performTapByTestID: No key window found");
            success = false;
            return;
        }

        // Find the view by accessibilityIdentifier
        UIView* targetView = findViewByAccessibilityIdentifier(keyWindow, identifier);
        if (!targetView) {
            NSLog(@"[Ennio] performTapByTestID: View with testID '%@' not found", identifier);
            success = false;
            return;
        }

        NSLog(@"[Ennio] performTapByTestID: Found view %@ with testID '%@'",
              NSStringFromClass([targetView class]), identifier);

        // Get the center point in window coordinates
        CGRect frameInWindow = [targetView convertRect:targetView.bounds toView:keyWindow];
        CGPoint centerPoint = CGPointMake(
            CGRectGetMidX(frameInWindow),
            CGRectGetMidY(frameInWindow)
        );

        NSLog(@"[Ennio] performTapByTestID: View frame in window: (%.1f, %.1f, %.1fx%.1f), center: (%.1f, %.1f)",
              frameInWindow.origin.x, frameInWindow.origin.y,
              frameInWindow.size.width, frameInWindow.size.height,
              centerPoint.x, centerPoint.y);

        // Now perform tap at this point
        success = EnnioRuntimeHelper::getInstance().performTap(centerPoint.x, centerPoint.y);
    };

    if ([NSThread isMainThread]) {
        tapBlock();
    } else {
        dispatchSyncMainWithTimeout(tapBlock);
    }

    return success;
}

bool EnnioRuntimeHelper::performTapByLabel(const std::string& label) {
    __block bool success = false;
    NSString* labelStr = [NSString stringWithUTF8String:label.c_str()];

    void (^tapBlock)(void) = ^{
        NSLog(@"[Ennio] performTapByLabel: Looking for element with label '%@'", labelStr);

        // Collect ALL windows
        NSMutableArray<UIWindow*>* allWindows = [NSMutableArray array];
        for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
            if ([scene isKindOfClass:[UIWindowScene class]]) {
                UIWindowScene* windowScene = (UIWindowScene*)scene;
                [allWindows addObjectsFromArray:windowScene.windows];
            }
        }

        // Sort by window level (highest first) to search modals first
        [allWindows sortUsingComparator:^NSComparisonResult(UIWindow* w1, UIWindow* w2) {
            if (w1.windowLevel > w2.windowLevel) return NSOrderedAscending;
            if (w1.windowLevel < w2.windowLevel) return NSOrderedDescending;
            return NSOrderedSame;
        }];

        NSLog(@"[Ennio] performTapByLabel: Searching %lu windows", (unsigned long)allWindows.count);

        // Find view by accessibility label in all windows
        UIView* targetView = nil;
        UIWindow* targetWindow = nil;

        for (UIWindow* window in allWindows) {
            if (!window.isHidden) {
                // First pass: find all matching views for debugging
                NSMutableArray<UIView*>* allMatches = [NSMutableArray array];
                findAllViewsByAccessibilityLabel(window, labelStr, allMatches);
                if (allMatches.count > 0) {
                    NSLog(@"[Ennio] performTapByLabel: Found %lu matches in window %@",
                          (unsigned long)allMatches.count, NSStringFromClass([window class]));
                    for (UIView* match in allMatches) {
                        CGRect frame = [match convertRect:match.bounds toView:window];
                        NSLog(@"[Ennio]   - %@ at (%.1f, %.1f, %.1fx%.1f) traits=%llu",
                              NSStringFromClass([match class]),
                              frame.origin.x, frame.origin.y,
                              frame.size.width, frame.size.height,
                              (unsigned long long)match.accessibilityTraits);
                    }
                }

                // Find best match (prefers buttons)
                UIView* found = findViewByAccessibilityLabel(window, labelStr);
                if (found) {
                    targetView = found;
                    targetWindow = window;
                    break;
                }
            }
        }

        if (!targetView || !targetWindow) {
            NSLog(@"[Ennio] performTapByLabel: No view with label '%@' found", labelStr);
            success = false;
            return;
        }

        NSLog(@"[Ennio] performTapByLabel: Found view %@ with label '%@' in window %@",
              NSStringFromClass([targetView class]), labelStr, NSStringFromClass([targetWindow class]));

        // Get the center point in window coordinates
        CGRect frameInWindow = [targetView convertRect:targetView.bounds toView:targetWindow];
        CGPoint centerPoint = CGPointMake(
            CGRectGetMidX(frameInWindow),
            CGRectGetMidY(frameInWindow)
        );

        NSLog(@"[Ennio] performTapByLabel: View frame: (%.1f, %.1f, %.1fx%.1f), center: (%.1f, %.1f)",
              frameInWindow.origin.x, frameInWindow.origin.y,
              frameInWindow.size.width, frameInWindow.size.height,
              centerPoint.x, centerPoint.y);

        // Perform tap at this point
        success = EnnioRuntimeHelper::getInstance().performTap(centerPoint.x, centerPoint.y);

        if (success) {
            NSLog(@"[Ennio] performTapByLabel: Successfully tapped '%@'", labelStr);
        } else {
            NSLog(@"[Ennio] performTapByLabel: Failed to tap '%@'", labelStr);
        }
    };

    if ([NSThread isMainThread]) {
        tapBlock();
    } else {
        dispatchSyncMainWithTimeout(tapBlock);
    }

    return success;
}

// Helper to find view by accessibilityIdentifier in ALL windows
static UIView* findViewByAccessibilityIdentifierInAllWindows(NSString* identifier) {
    NSMutableArray<UIWindow*>* allWindows = [NSMutableArray array];

    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            [allWindows addObjectsFromArray:windowScene.windows];
        }
    }

    NSLog(@"[Ennio] findViewByAccessibilityIdentifierInAllWindows: Searching %lu windows for '%@'",
          (unsigned long)allWindows.count, identifier);

    // Sort by window level (highest first) to find views in modals first
    [allWindows sortUsingComparator:^NSComparisonResult(UIWindow* w1, UIWindow* w2) {
        if (w1.windowLevel > w2.windowLevel) return NSOrderedAscending;
        if (w1.windowLevel < w2.windowLevel) return NSOrderedDescending;
        return NSOrderedSame;
    }];

    for (UIWindow* window in allWindows) {
        if (!window.isHidden && window.alpha > 0) {
            UIView* found = findViewByAccessibilityIdentifier(window, identifier);
            if (found) {
                NSLog(@"[Ennio] findViewByAccessibilityIdentifierInAllWindows: Found '%@' in window %@ (level: %.0f)",
                      identifier, NSStringFromClass([window class]), window.windowLevel);
                return found;
            }
        }
    }

    return nil;
}

bool EnnioRuntimeHelper::performTypeText(const std::string& testID, const std::string& text) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];
    NSString* textToType = [NSString stringWithUTF8String:text.c_str()];

    void (^typeBlock)(void) = ^{
        // Search ALL windows for the view by accessibilityIdentifier
        UIView* targetView = findViewByAccessibilityIdentifierInAllWindows(identifier);
        if (!targetView) {
            NSLog(@"[Ennio] performTypeText: View with testID '%@' not found in any window", identifier);
            success = false;
            return;
        }

        NSLog(@"[Ennio] performTypeText: Found view %@ with testID '%@'",
              NSStringFromClass([targetView class]), identifier);

        // Try to find a UITextField or UITextView in the view hierarchy
        UITextField* textField = nil;
        UITextView* textView = nil;
        UIView* componentView = nil;  // The RCTTextInputComponentView parent

        // Check if it's a text input directly
        if ([targetView isKindOfClass:[UITextField class]]) {
            textField = (UITextField*)targetView;
        } else if ([targetView isKindOfClass:[UITextView class]]) {
            textView = (UITextView*)targetView;
        } else {
            // Search subviews for text input
            for (UIView* subview in targetView.subviews) {
                if ([subview isKindOfClass:[UITextField class]]) {
                    textField = (UITextField*)subview;
                    break;
                } else if ([subview isKindOfClass:[UITextView class]]) {
                    textView = (UITextView*)subview;
                    break;
                }
            }
        }

        // Find the RCTTextInputComponentView which is the delegate
        // It's typically the superview of the text field
        if (textField) {
            componentView = textField.superview;
        } else if (textView) {
            componentView = textView.superview;
        }

        // Log the component view hierarchy
        if (componentView) {
            NSLog(@"[Ennio] performTypeText: ComponentView is %@",
                  NSStringFromClass([componentView class]));
        }

        if (textField) {
            NSLog(@"[Ennio] performTypeText: Setting text on UITextField");

            // Make it first responder (focus)
            [textField becomeFirstResponder];

            // Set the text using attributed text to match React Native's internal state
            // React Native uses attributed text internally, so setting plain text may not
            // trigger the proper state updates
            NSDictionary* attributes = textField.defaultTextAttributes ?: @{};
            NSAttributedString* attrStr = [[NSAttributedString alloc] initWithString:textToType
                                                                          attributes:attributes];
            textField.attributedText = attrStr;

            NSLog(@"[Ennio] performTypeText: Set attributed text, actual text now: '%@'", textField.text);

            // Try to find and call textInputDidChange on the component view
            // This is how React Native's Fabric TextInput handles text changes
            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            id delegate = textField.delegate;

            NSLog(@"[Ennio] performTypeText: TextField delegate class: %@",
                  delegate ? NSStringFromClass([delegate class]) : @"nil");

            // The component view (superview) should be RCTTextInputComponentView
            // which implements the textInputDidChange method
            UIView* parentView = componentView;
            if (parentView && [parentView respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Ennio] performTypeText: Calling textInputDidChange on parent view");

                // First, trigger the text field's editing changed action to notify any observers
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];

                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [parentView performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop

                // Allow React's async update to process
                [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
                NSLog(@"[Ennio] performTypeText: After delay, text field text: '%@'", textField.text);
            } else if (delegate && [delegate respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Ennio] performTypeText: Calling textInputDidChange on delegate");
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [delegate performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            } else {
                NSLog(@"[Ennio] performTypeText: No textInputDidChange found, trying fallback");
                // Fallback to sendActionsForControlEvents
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];

                // Also try calling textFieldDidChange on the delegate
                SEL textFieldDidChangeSel = NSSelectorFromString(@"textFieldDidChange:");
                if (delegate && [delegate respondsToSelector:textFieldDidChangeSel]) {
                    NSLog(@"[Ennio] performTypeText: Calling textFieldDidChange on delegate");
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    [delegate performSelector:textFieldDidChangeSel withObject:textField];
                    #pragma clang diagnostic pop
                }
            }

            success = true;
        } else if (textView) {
            NSLog(@"[Ennio] performTypeText: Setting text on UITextView");

            // Make it first responder (focus)
            [textView becomeFirstResponder];

            // Set the text directly
            textView.text = textToType;

            // Try to call textInputDidChange on the delegate
            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            id delegate = textView.delegate;
            if (delegate && [delegate respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Ennio] performTypeText: Calling textInputDidChange on delegate");
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [delegate performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            } else if (delegate && [delegate respondsToSelector:@selector(textViewDidChange:)]) {
                [delegate performSelector:@selector(textViewDidChange:) withObject:textView];
            }

            success = true;
        } else {
            NSLog(@"[Ennio] performTypeText: No UITextField or UITextView found in view");
            success = false;
        }
    };

    if ([NSThread isMainThread]) {
        typeBlock();
    } else {
        dispatchSyncMainWithTimeout(typeBlock);
    }

    return success;
}

bool EnnioRuntimeHelper::performClearText(const std::string& testID) {
    return performTypeText(testID, "");
}

// Helper to find UITextField or UITextView in a view hierarchy (searching up and down)
static UIView* findTextInputInHierarchy(UIView* startView) {
    // First check if startView itself is a text input
    if ([startView isKindOfClass:[UITextField class]] ||
        [startView isKindOfClass:[UITextView class]]) {
        return startView;
    }

    // Search subviews (descendants)
    for (UIView* subview in startView.subviews) {
        UIView* found = findTextInputInHierarchy(subview);
        if (found) {
            return found;
        }
    }

    // Search parent hierarchy (ancestors)
    UIView* parent = startView.superview;
    while (parent) {
        if ([parent isKindOfClass:[UITextField class]] ||
            [parent isKindOfClass:[UITextView class]]) {
            return parent;
        }
        // Also check siblings of ancestors
        for (UIView* sibling in parent.subviews) {
            if (sibling != startView &&
                ([sibling isKindOfClass:[UITextField class]] ||
                 [sibling isKindOfClass:[UITextView class]])) {
                return sibling;
            }
        }
        parent = parent.superview;
    }

    return nil;
}

// Helper to find the current first responder (focused view)
static UIView* findFirstResponder(UIView* view) {
    if ([view isFirstResponder]) {
        return view;
    }
    for (UIView* subview in view.subviews) {
        UIView* found = findFirstResponder(subview);
        if (found) {
            return found;
        }
    }
    return nil;
}

// Helper to find first responder across all windows
static UIView* findFirstResponderInAllWindows() {
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            for (UIWindow* window in windowScene.windows) {
                UIView* responder = findFirstResponder(window);
                if (responder) {
                    return responder;
                }
            }
        }
    }
    return nil;
}

bool EnnioRuntimeHelper::performTypeTextAtPoint(float x, float y, const std::string& text) {
    __block bool success = false;
    NSString* textToType = [NSString stringWithUTF8String:text.c_str()];
    CGPoint point = CGPointMake(x, y);

    void (^typeBlock)(void) = ^{
        NSLog(@"[Ennio] performTypeTextAtPoint: point=(%.1f, %.1f) text='%@'", x, y, textToType);

        UIView* textInputView = nil;

        // FIRST: Try to find the currently focused text input (first responder)
        // This works when tap was already performed to focus the input
        UIView* focusedResponder = findFirstResponderInAllWindows();
        if (focusedResponder) {
            NSLog(@"[Ennio] performTypeTextAtPoint: Found first responder: %@ (id: %@)",
                  NSStringFromClass([focusedResponder class]),
                  focusedResponder.accessibilityIdentifier ?: @"nil");
            textInputView = findTextInputInHierarchy(focusedResponder);
            if (textInputView) {
                NSLog(@"[Ennio] performTypeTextAtPoint: Using focused text input");
            }
        }

        // If no focused text input, fall back to hitTest at coordinates
        if (!textInputView) {
            NSLog(@"[Ennio] performTypeTextAtPoint: No focused text input, trying hitTest");
            UIWindow* targetWindow = findWindowAtPoint(point);
            if (targetWindow) {
                UIView* hitView = [targetWindow hitTest:point withEvent:nil];
                if (hitView) {
                    NSLog(@"[Ennio] performTypeTextAtPoint: Hit view %@ (accessibilityIdentifier: %@)",
                          NSStringFromClass([hitView class]),
                          hitView.accessibilityIdentifier ?: @"nil");
                    textInputView = findTextInputInHierarchy(hitView);
                }
            }
        }

        if (!textInputView) {
            NSLog(@"[Ennio] performTypeTextAtPoint: No text input found via first responder or hitTest");
            success = false;
            return;
        }

        UITextField* textField = nil;
        UITextView* textView = nil;
        UIView* componentView = nil;

        if ([textInputView isKindOfClass:[UITextField class]]) {
            textField = (UITextField*)textInputView;
            componentView = textField.superview;
        } else if ([textInputView isKindOfClass:[UITextView class]]) {
            textView = (UITextView*)textInputView;
            componentView = textView.superview;
        }

        if (textField) {
            NSLog(@"[Ennio] performTypeTextAtPoint: Found UITextField");

            // Make it first responder (focus)
            [textField becomeFirstResponder];

            // Set the text using attributed text
            NSDictionary* attributes = textField.defaultTextAttributes ?: @{};
            NSAttributedString* attrStr = [[NSAttributedString alloc] initWithString:textToType
                                                                          attributes:attributes];
            textField.attributedText = attrStr;

            NSLog(@"[Ennio] performTypeTextAtPoint: Set text, actual text now: '%@'", textField.text);

            // Trigger text change notification
            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            UIView* parentView = componentView;
            if (parentView && [parentView respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Ennio] performTypeTextAtPoint: Calling textInputDidChange on parent view");
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [parentView performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
                [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
            } else {
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];
            }

            success = true;
        } else if (textView) {
            NSLog(@"[Ennio] performTypeTextAtPoint: Found UITextView");

            [textView becomeFirstResponder];
            textView.text = textToType;

            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            id delegate = textView.delegate;
            if (delegate && [delegate respondsToSelector:textInputDidChangeSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [delegate performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            } else if (delegate && [delegate respondsToSelector:@selector(textViewDidChange:)]) {
                [delegate performSelector:@selector(textViewDidChange:) withObject:textView];
            }

            success = true;
        } else {
            NSLog(@"[Ennio] performTypeTextAtPoint: No UITextField or UITextView found in hierarchy");
            success = false;
        }
    };

    if ([NSThread isMainThread]) {
        typeBlock();
    } else {
        dispatchSyncMainWithTimeout(typeBlock);
    }

    return success;
}

bool EnnioRuntimeHelper::performClearTextAtPoint(float x, float y) {
    return performTypeTextAtPoint(x, y, "");
}

// ============================================
// Scroll Handling
// ============================================

// Helper to find UIScrollView in a view's hierarchy
static UIScrollView* findScrollViewInView(UIView* view) {
    if ([view isKindOfClass:[UIScrollView class]]) {
        return (UIScrollView*)view;
    }

    for (UIView* subview in view.subviews) {
        UIScrollView* found = findScrollViewInView(subview);
        if (found) {
            return found;
        }
    }

    return nil;
}

bool EnnioRuntimeHelper::performScroll(const std::string& testID, float deltaX, float deltaY) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];

    void (^scrollBlock)(void) = ^{
        // Search ALL windows for the view
        UIView* view = findViewByAccessibilityIdentifierInAllWindows(identifier);
        if (!view) {
            NSLog(@"[Ennio] performScroll: View not found for testID: %@", identifier);
            success = false;
            return;
        }

        // Find the UIScrollView - either the view itself or a child
        UIScrollView* scrollView = nil;
        if ([view isKindOfClass:[UIScrollView class]]) {
            scrollView = (UIScrollView*)view;
        } else {
            scrollView = findScrollViewInView(view);
        }

        if (!scrollView) {
            NSLog(@"[Ennio] performScroll: No UIScrollView found for testID: %@", identifier);
            success = false;
            return;
        }

        NSLog(@"[Ennio] performScroll: Found scroll view, current offset: (%.1f, %.1f)",
              scrollView.contentOffset.x, scrollView.contentOffset.y);

        // Calculate new offset
        CGPoint currentOffset = scrollView.contentOffset;
        CGPoint newOffset = CGPointMake(
            currentOffset.x + deltaX,
            currentOffset.y + deltaY
        );

        // Clamp to valid bounds
        CGFloat maxX = MAX(0, scrollView.contentSize.width - scrollView.bounds.size.width);
        CGFloat maxY = MAX(0, scrollView.contentSize.height - scrollView.bounds.size.height);
        newOffset.x = MAX(0, MIN(newOffset.x, maxX));
        newOffset.y = MAX(0, MIN(newOffset.y, maxY));

        NSLog(@"[Ennio] performScroll: Scrolling to offset: (%.1f, %.1f)", newOffset.x, newOffset.y);

        // Perform the scroll
        [scrollView setContentOffset:newOffset animated:YES];

        success = true;
    };

    if ([NSThread isMainThread]) {
        scrollBlock();
    } else {
        dispatchSyncMainWithTimeout(scrollBlock);
    }

    return success;
}

bool EnnioRuntimeHelper::performScrollTo(const std::string& testID, float x, float y, bool animated) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];

    void (^scrollBlock)(void) = ^{
        // Search ALL windows for the view
        UIView* view = findViewByAccessibilityIdentifierInAllWindows(identifier);
        if (!view) {
            NSLog(@"[Ennio] performScrollTo: View not found for testID: %@", identifier);
            success = false;
            return;
        }

        // Find the UIScrollView
        UIScrollView* scrollView = nil;
        if ([view isKindOfClass:[UIScrollView class]]) {
            scrollView = (UIScrollView*)view;
        } else {
            scrollView = findScrollViewInView(view);
        }

        if (!scrollView) {
            NSLog(@"[Ennio] performScrollTo: No UIScrollView found for testID: %@", identifier);
            success = false;
            return;
        }

        NSLog(@"[Ennio] performScrollTo: Scrolling to (%.1f, %.1f) animated=%d", x, y, animated);

        // Clamp to valid bounds
        CGFloat maxX = MAX(0, scrollView.contentSize.width - scrollView.bounds.size.width);
        CGFloat maxY = MAX(0, scrollView.contentSize.height - scrollView.bounds.size.height);
        CGPoint targetOffset = CGPointMake(
            MAX(0, MIN(x, maxX)),
            MAX(0, MIN(y, maxY))
        );

        [scrollView setContentOffset:targetOffset animated:animated];
        success = true;
    };

    if ([NSThread isMainThread]) {
        scrollBlock();
    } else {
        dispatchSyncMainWithTimeout(scrollBlock);
    }

    return success;
}

// ============================================
// Alert/Modal Handling
// ============================================

// Helper to find the presented alert controller
static UIAlertController* findPresentedAlertController() {
    UIViewController* rootVC = nil;

    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            for (UIWindow* window in windowScene.windows) {
                if (window.isKeyWindow) {
                    rootVC = window.rootViewController;
                    break;
                }
            }
        }
        if (rootVC) break;
    }

    if (!rootVC) return nil;

    // Walk up the presented view controller chain to find an alert
    UIViewController* currentVC = rootVC;
    while (currentVC.presentedViewController) {
        currentVC = currentVC.presentedViewController;
        if ([currentVC isKindOfClass:[UIAlertController class]]) {
            return (UIAlertController*)currentVC;
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

bool EnnioRuntimeHelper::tapAlertButton(const std::string& buttonText) {
    __block bool success = false;
    NSString* targetButtonText = [NSString stringWithUTF8String:buttonText.c_str()];

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) {
            NSLog(@"[Ennio] tapAlertButton: No alert found");
            return;
        }

        // Find the action with matching title
        UIAlertAction* targetAction = nil;
        for (UIAlertAction* action in alert.actions) {
            if ([action.title isEqualToString:targetButtonText]) {
                targetAction = action;
                break;
            }
        }

        if (!targetAction) {
            NSLog(@"[Ennio] tapAlertButton: Button '%@' not found", targetButtonText);
            return;
        }

        NSLog(@"[Ennio] tapAlertButton: Found button '%@', triggering", targetButtonText);

        // Get the handler block using KVC (private API but reliable)
        void (^handler)(UIAlertAction*) = nil;
        @try {
            handler = [targetAction valueForKey:@"handler"];
        } @catch (NSException* e) {
            NSLog(@"[Ennio] tapAlertButton: Could not get handler via KVC: %@", e);
        }

        // Dismiss the alert first, then call the handler
        UIViewController* presentingVC = alert.presentingViewController;
        [alert dismissViewControllerAnimated:NO completion:^{
            // Call the handler after dismissal
            if (handler) {
                NSLog(@"[Ennio] tapAlertButton: Invoking handler for '%@'", targetButtonText);
                handler(targetAction);
            }
        }];

        success = true;
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::dismissAlert() {
    __block bool success = false;

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) {
            NSLog(@"[Ennio] dismissAlert: No alert found");
            return;
        }

        NSLog(@"[Ennio] dismissAlert: Dismissing alert");

        // Find a cancel-style action, or the first action
        UIAlertAction* targetAction = nil;
        for (UIAlertAction* action in alert.actions) {
            if (action.style == UIAlertActionStyleCancel) {
                targetAction = action;
                break;
            }
        }

        if (!targetAction && alert.actions.count > 0) {
            // Use the last action (often "OK" or "Cancel")
            targetAction = alert.actions.lastObject;
        }

        // Get the handler using KVC (same approach as tapAlertButton)
        void (^handler)(UIAlertAction*) = nil;
        if (targetAction) {
            @try {
                handler = [targetAction valueForKey:@"handler"];
            } @catch (NSException* e) {
                NSLog(@"[Ennio] dismissAlert: Could not get handler via KVC: %@", e);
            }
        }

        // Dismiss the alert first, then call the handler
        [alert dismissViewControllerAnimated:NO completion:^{
            if (handler && targetAction) {
                NSLog(@"[Ennio] dismissAlert: Invoking handler");
                handler(targetAction);
            }
        }];
        success = true;
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

// ============================================
// Keyboard Handling
// ============================================

bool EnnioRuntimeHelper::hideKeyboard() {
    __block bool success = false;

    void (^block)(void) = ^{
        NSLog(@"[Ennio] hideKeyboard: Resigning first responder");

        // Find and resign the current first responder
        UIView* firstResponder = findFirstResponderInAllWindows();
        if (firstResponder) {
            [firstResponder resignFirstResponder];
            success = true;
            NSLog(@"[Ennio] hideKeyboard: Resigned first responder: %@", NSStringFromClass([firstResponder class]));
        } else {
            // Alternative: send endEditing to the key window
            UIWindow* keyWindow = findKeyWindow();
            if (keyWindow) {
                [keyWindow endEditing:YES];
                success = true;
                NSLog(@"[Ennio] hideKeyboard: Called endEditing on key window");
            } else {
                NSLog(@"[Ennio] hideKeyboard: No first responder or key window found");
            }
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::eraseText(int count) {
    __block bool success = false;

    void (^block)(void) = ^{
        NSLog(@"[Ennio] eraseText: Erasing %d characters", count);

        UIView* firstResponder = findFirstResponderInAllWindows();
        if (!firstResponder) {
            NSLog(@"[Ennio] eraseText: No first responder found");
            return;
        }

        // Check if it's a text field or text view
        if ([firstResponder isKindOfClass:[UITextField class]]) {
            UITextField* textField = (UITextField*)firstResponder;
            NSString* currentText = textField.text ?: @"";

            if (currentText.length > 0) {
                NSInteger charsToRemove = MIN(count, (int)currentText.length);
                NSString* newText = [currentText substringToIndex:currentText.length - charsToRemove];
                textField.text = newText;

                // Trigger text change notification
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];

                SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
                UIView* componentView = textField.superview;
                if (componentView && [componentView respondsToSelector:textInputDidChangeSel]) {
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    [componentView performSelector:textInputDidChangeSel];
                    #pragma clang diagnostic pop
                }

                success = true;
                NSLog(@"[Ennio] eraseText: Erased %ld characters, new text: '%@'", (long)charsToRemove, newText);
            }
        } else if ([firstResponder isKindOfClass:[UITextView class]]) {
            UITextView* textView = (UITextView*)firstResponder;
            NSString* currentText = textView.text ?: @"";

            if (currentText.length > 0) {
                NSInteger charsToRemove = MIN(count, (int)currentText.length);
                NSString* newText = [currentText substringToIndex:currentText.length - charsToRemove];
                textView.text = newText;

                id delegate = textView.delegate;
                if (delegate && [delegate respondsToSelector:@selector(textViewDidChange:)]) {
                    [delegate performSelector:@selector(textViewDidChange:) withObject:textView];
                }

                success = true;
                NSLog(@"[Ennio] eraseText: Erased %ld characters from UITextView", (long)charsToRemove);
            }
        } else {
            NSLog(@"[Ennio] eraseText: First responder is not a text input: %@", NSStringFromClass([firstResponder class]));
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::pressKey(const std::string& keyName) {
    __block bool success = false;
    NSString* keyNameStr = [NSString stringWithUTF8String:keyName.c_str()];

    void (^block)(void) = ^{
        NSLog(@"[Ennio] pressKey: Pressing key '%@'", keyNameStr);

        UIView* firstResponder = findFirstResponderInAllWindows();

        // Handle special keys
        if ([keyNameStr caseInsensitiveCompare:@"Enter"] == NSOrderedSame ||
            [keyNameStr caseInsensitiveCompare:@"Return"] == NSOrderedSame) {

            if ([firstResponder isKindOfClass:[UITextField class]]) {
                UITextField* textField = (UITextField*)firstResponder;
                id delegate = textField.delegate;
                if (delegate && [delegate respondsToSelector:@selector(textFieldShouldReturn:)]) {
                    [delegate performSelector:@selector(textFieldShouldReturn:) withObject:textField];
                }
                success = true;
            } else if ([firstResponder isKindOfClass:[UITextView class]]) {
                UITextView* textView = (UITextView*)firstResponder;
                // Insert newline
                textView.text = [textView.text stringByAppendingString:@"\n"];
                success = true;
            }
        } else if ([keyNameStr caseInsensitiveCompare:@"Tab"] == NSOrderedSame) {
            // Tab - try to move to next responder
            UIView* nextResponder = [firstResponder.superview viewWithTag:firstResponder.tag + 1];
            if (nextResponder && [nextResponder canBecomeFirstResponder]) {
                [nextResponder becomeFirstResponder];
                success = true;
            }
        } else if ([keyNameStr caseInsensitiveCompare:@"Escape"] == NSOrderedSame) {
            // Escape - resign first responder (hide keyboard)
            [firstResponder resignFirstResponder];
            success = true;
        } else if ([keyNameStr caseInsensitiveCompare:@"Backspace"] == NSOrderedSame ||
                   [keyNameStr caseInsensitiveCompare:@"Delete"] == NSOrderedSame) {
            // Delete one character
            success = EnnioRuntimeHelper::getInstance().eraseText(1);
        } else {
            NSLog(@"[Ennio] pressKey: Unknown key '%@'", keyNameStr);
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

// ============================================
// Clipboard Handling
// ============================================

bool EnnioRuntimeHelper::copyToClipboard(const std::string& text) {
    __block bool success = false;
    NSString* textStr = [NSString stringWithUTF8String:text.c_str()];

    void (^block)(void) = ^{
        NSLog(@"[Ennio] copyToClipboard: Copying text to clipboard");
        UIPasteboard* pasteboard = [UIPasteboard generalPasteboard];
        pasteboard.string = textStr;
        success = YES;
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::pasteFromClipboard() {
    __block bool success = false;

    void (^block)(void) = ^{
        NSLog(@"[Ennio] pasteFromClipboard: Pasting from clipboard");

        UIPasteboard* pasteboard = [UIPasteboard generalPasteboard];
        NSString* text = pasteboard.string;

        if (!text || text.length == 0) {
            NSLog(@"[Ennio] pasteFromClipboard: Clipboard is empty");
            return;
        }

        UIView* firstResponder = findFirstResponderInAllWindows();
        if (!firstResponder) {
            NSLog(@"[Ennio] pasteFromClipboard: No first responder found");
            return;
        }

        if ([firstResponder isKindOfClass:[UITextField class]]) {
            UITextField* textField = (UITextField*)firstResponder;

            // Insert at current cursor position or append
            NSString* currentText = textField.text ?: @"";
            textField.text = [currentText stringByAppendingString:text];

            [textField sendActionsForControlEvents:UIControlEventEditingChanged];

            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            UIView* componentView = textField.superview;
            if (componentView && [componentView respondsToSelector:textInputDidChangeSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [componentView performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            }

            success = true;
            NSLog(@"[Ennio] pasteFromClipboard: Pasted text into UITextField");
        } else if ([firstResponder isKindOfClass:[UITextView class]]) {
            UITextView* textView = (UITextView*)firstResponder;
            NSString* currentText = textView.text ?: @"";
            textView.text = [currentText stringByAppendingString:text];

            id delegate = textView.delegate;
            if (delegate && [delegate respondsToSelector:@selector(textViewDidChange:)]) {
                [delegate performSelector:@selector(textViewDidChange:) withObject:textView];
            }

            success = true;
            NSLog(@"[Ennio] pasteFromClipboard: Pasted text into UITextView");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

std::string EnnioRuntimeHelper::getClipboardText() {
    __block std::string result;

    void (^block)(void) = ^{
        UIPasteboard* pasteboard = [UIPasteboard generalPasteboard];
        NSString* text = pasteboard.string;
        if (text) {
            result = [text UTF8String];
            NSLog(@"[Ennio] getClipboardText: Got text from clipboard");
        } else {
            NSLog(@"[Ennio] getClipboardText: Clipboard is empty");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return result;
}

// ============================================
// Device Control
// ============================================

bool EnnioRuntimeHelper::setOrientation(int orientation) {
    __block bool success = false;

    void (^block)(void) = ^{
        NSLog(@"[Ennio] setOrientation: Setting orientation to %d", orientation);

        UIInterfaceOrientation targetOrientation;
        switch (orientation) {
            case 0:
                targetOrientation = UIInterfaceOrientationPortrait;
                break;
            case 1:
                targetOrientation = UIInterfaceOrientationPortraitUpsideDown;
                break;
            case 2:
                targetOrientation = UIInterfaceOrientationLandscapeLeft;
                break;
            case 3:
                targetOrientation = UIInterfaceOrientationLandscapeRight;
                break;
            default:
                NSLog(@"[Ennio] setOrientation: Invalid orientation %d", orientation);
                return;
        }

        // For iOS 16+, use the new UIWindowScene API
        if (@available(iOS 16.0, *)) {
            for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
                if ([scene isKindOfClass:[UIWindowScene class]]) {
                    UIWindowScene* windowScene = (UIWindowScene*)scene;

                    UIWindowSceneGeometryPreferencesIOS* preferences =
                        [[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:
                            (1 << targetOrientation)];

                    NSError* error = nil;
                    [windowScene requestGeometryUpdateWithPreferences:preferences errorHandler:^(NSError* err) {
                        if (err) {
                            NSLog(@"[Ennio] setOrientation: Error setting orientation: %@", err);
                        }
                    }];

                    success = YES;
                    break;
                }
            }
        } else {
            // For older iOS, use UIDevice orientation (deprecated but works)
            [[UIDevice currentDevice] setValue:@(targetOrientation) forKey:@"orientation"];
            [UIViewController attemptRotationToDeviceOrientation];
            success = YES;
        }

        NSLog(@"[Ennio] setOrientation: Result = %@", success ? @"YES" : @"NO");
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::performSwipe(float startX, float startY, float endX, float endY, float durationMs) {
    __block bool success = false;

    void (^block)(void) = ^{
        NSLog(@"[Ennio] performSwipe: (%.1f, %.1f) -> (%.1f, %.1f) duration=%.0fms",
              startX, startY, endX, endY, durationMs);

        CGPoint startPoint = CGPointMake(startX, startY);
        CGPoint endPoint = CGPointMake(endX, endY);

        UIWindow* targetWindow = findWindowAtPoint(startPoint);
        if (!targetWindow) {
            NSLog(@"[Ennio] performSwipe: No window found at start point");
            return;
        }

        UIView* hitView = [targetWindow hitTest:startPoint withEvent:nil];
        if (!hitView) {
            hitView = targetWindow;
        }

        // Create the touch
        UITouch* touch = [[UITouch alloc] init];
        NSTimeInterval startTime = [[NSProcessInfo processInfo] systemUptime];

        // Touch began
        [touch setWindow:targetWindow];
        [touch setView:hitView];
        [touch setPhase:UITouchPhaseBegan];
        [touch setTapCount:1];
        [touch _setLocationInWindow:startPoint resetPrevious:YES];
        [touch setTimestamp:startTime];
        [touch _setIsFirstTouchForView:YES];

        UIApplication* app = [UIApplication sharedApplication];
        UIEvent* event = [app _touchesEvent];
        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];
        [app sendEvent:event];

        // Animate the touch movement
        int steps = MAX(10, (int)(durationMs / 16)); // ~60fps
        float stepDuration = (durationMs / 1000.0f) / steps;

        for (int i = 1; i <= steps; i++) {
            float progress = (float)i / steps;
            CGPoint currentPoint = CGPointMake(
                startPoint.x + (endPoint.x - startPoint.x) * progress,
                startPoint.y + (endPoint.y - startPoint.y) * progress
            );

            [touch setPhase:UITouchPhaseMoved];
            [touch _setLocationInWindow:currentPoint resetPrevious:NO];
            [touch setTimestamp:startTime + (stepDuration * i)];

            [event _clearTouches];
            [event _addTouch:touch forDelayedDelivery:NO];
            [app sendEvent:event];

            usleep((useconds_t)(stepDuration * 1000000));
        }

        // Touch ended
        [touch setPhase:UITouchPhaseEnded];
        [touch _setLocationInWindow:endPoint resetPrevious:NO];
        [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];

        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];
        [app sendEvent:event];

        success = true;
        NSLog(@"[Ennio] performSwipe: Completed swipe gesture");
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatchSyncMainWithTimeout(block);
    }

    return success;
}

bool EnnioRuntimeHelper::performBackGesture() {
    NSLog(@"[Ennio] performBackGesture: Simulating edge swipe from left");

    // Get screen dimensions
    CGRect screenBounds = [[UIScreen mainScreen] bounds];
    float screenWidth = screenBounds.size.width;
    float screenHeight = screenBounds.size.height;

    // Swipe from left edge to center
    float startX = 10; // Near left edge
    float startY = screenHeight / 2;
    float endX = screenWidth / 2;
    float endY = screenHeight / 2;
    float duration = 300; // 300ms

    return performSwipe(startX, startY, endX, endY, duration);
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
