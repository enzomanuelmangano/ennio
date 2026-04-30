//
// TastoRuntimeHelper.mm
// Objective-C++ implementation for accessing React Native runtime
//

#import "TastoRuntimeHelper.h"
#import <React/RCTSurfacePresenter.h>
#import <React/RCTScheduler.h>
#import <react/renderer/core/ShadowNode.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <unistd.h>

// Private UITouch methods we need to call
@interface UITouch (TastoPrivate)
- (void)setView:(UIView *)view;
- (void)setWindow:(UIWindow *)window;
- (void)setPhase:(UITouchPhase)phase;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)_setIsFirstTouchForView:(BOOL)isFirst;
@end

// Private UIEvent methods
@interface UIEvent (TastoPrivate)
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_clearTouches;
@end

// Private application methods for creating touch events
@interface UIApplication (TastoPrivate)
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

    NSLog(@"[Tasto] findWindowAtPoint: Found %lu windows total", (unsigned long)allWindows.count);

    // Sort by window level (highest first) and check if point is in window
    [allWindows sortUsingComparator:^NSComparisonResult(UIWindow* w1, UIWindow* w2) {
        if (w1.windowLevel > w2.windowLevel) return NSOrderedAscending;
        if (w1.windowLevel < w2.windowLevel) return NSOrderedDescending;
        return NSOrderedSame;
    }];

    for (UIWindow* window in allWindows) {
        NSLog(@"[Tasto] findWindowAtPoint: Checking window %@ (level: %.0f, hidden: %d, alpha: %.1f)",
              NSStringFromClass([window class]), window.windowLevel, window.isHidden, window.alpha);

        if (!window.isHidden && window.alpha > 0) {
            UIView* hitView = [window hitTest:point withEvent:nil];
            if (hitView && hitView != window) {
                NSLog(@"[Tasto] findWindowAtPoint: Using window with hitView %@",
                      NSStringFromClass([hitView class]));
                return window;
            }
        }
    }

    // Fallback to key window
    for (UIWindow* window in allWindows) {
        if (window.isKeyWindow) {
            NSLog(@"[Tasto] findWindowAtPoint: Falling back to key window");
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

namespace tasto {

TastoRuntimeHelper& TastoRuntimeHelper::getInstance() {
    static TastoRuntimeHelper instance;
    return instance;
}

void TastoRuntimeHelper::setSurfacePresenter(void* surfacePresenter) {
    surfacePresenter_ = surfacePresenter;
    NSLog(@"[Tasto] TastoRuntimeHelper::setSurfacePresenter called with %p", surfacePresenter);
}

// Helper to find surface presenter by looking through runtime objects
static RCTSurfacePresenter* findSurfacePresenterInRuntime() {
    NSLog(@"[Tasto] Searching for surface presenter...");

    // Try to access through the app delegate
    UIApplication* app = [UIApplication sharedApplication];
    id appDelegate = app.delegate;

    NSLog(@"[Tasto] AppDelegate class: %@", NSStringFromClass([appDelegate class]));

    // Method 1: Try reactNativeFactory -> reactHost -> surfacePresenter (newer Expo pattern)
    SEL factorySel = NSSelectorFromString(@"reactNativeFactory");
    if ([appDelegate respondsToSelector:factorySel]) {
        #pragma clang diagnostic push
        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        id factory = [appDelegate performSelector:factorySel];
        #pragma clang diagnostic pop

        if (factory) {
            NSLog(@"[Tasto] Found reactNativeFactory: %@", NSStringFromClass([factory class]));

            // Try reactHost first
            SEL hostSel = NSSelectorFromString(@"reactHost");
            if ([factory respondsToSelector:hostSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                id host = [factory performSelector:hostSel];
                #pragma clang diagnostic pop

                if (host) {
                    NSLog(@"[Tasto] Found reactHost: %@", NSStringFromClass([host class]));

                    SEL presenterSel = NSSelectorFromString(@"surfacePresenter");
                    if ([host respondsToSelector:presenterSel]) {
                        #pragma clang diagnostic push
                        #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                        id presenter = [host performSelector:presenterSel];
                        #pragma clang diagnostic pop

                        if (presenter) {
                            NSLog(@"[Tasto] Found surfacePresenter via host: %@", presenter);
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
                    NSLog(@"[Tasto] Found surfacePresenter on factory: %@", presenter);
                    return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
                }
            }

            // Log available methods on factory for debugging
            NSLog(@"[Tasto] Factory methods:");
            unsigned int count;
            Method *methods = class_copyMethodList([factory class], &count);
            for (unsigned int i = 0; i < count && i < 20; i++) {
                NSLog(@"[Tasto]   - %@", NSStringFromSelector(method_getName(methods[i])));
            }
            free(methods);
        }
    }

    // Method 2: Search windows for RCTSurfaceHostingView
    NSLog(@"[Tasto] Searching windows for RCTSurfaceHostingView...");
    for (UIScene* scene in [[UIApplication sharedApplication] connectedScenes]) {
        if ([scene isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene* windowScene = (UIWindowScene*)scene;
            for (UIWindow* window in windowScene.windows) {
                UIViewController* rootVC = window.rootViewController;
                if (rootVC && rootVC.view) {
                    // Look for RCTRootContentView or RCTSurfaceHostingView
                    for (UIView* subview in rootVC.view.subviews) {
                        NSString* className = NSStringFromClass([subview class]);
                        NSLog(@"[Tasto] Found view: %@", className);

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
                                            NSLog(@"[Tasto] Found surfacePresenter via view: %@", presenter);
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

    NSLog(@"[Tasto] Could not find surface presenter");
    return nil;
}

std::shared_ptr<facebook::react::UIManager> TastoRuntimeHelper::getUIManager() {
    NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager called, cached=%p", surfacePresenter_);

    __block std::shared_ptr<facebook::react::UIManager> result = nullptr;

    void (^getUIManagerBlock)(void) = ^{
        @try {
            RCTSurfacePresenter* presenter = nil;

            // First try cached presenter from swizzling
            if (surfacePresenter_) {
                presenter = (__bridge RCTSurfacePresenter*)surfacePresenter_;
                NSLog(@"[Tasto] Using cached surfacePresenter: %@", presenter);
            }

            // If no cached, try runtime search
            if (!presenter) {
                presenter = findSurfacePresenterInRuntime();
                if (presenter) {
                    surfacePresenter_ = (__bridge void*)presenter;
                }
            }

            if (!presenter) {
                NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: Could not find surface presenter");
                return;
            }

            RCTScheduler* scheduler = [presenter scheduler];
            if (!scheduler) {
                NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: scheduler is null");
                return;
            }

            NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: scheduler=%@", scheduler);

            result = [scheduler uiManager];
            NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: uiManager=%s", result ? "valid" : "null");
        } @catch (NSException *exception) {
            NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: Exception: %@", exception);
        }
    };

    // Must access surface presenter and scheduler from main thread
    if ([NSThread isMainThread]) {
        getUIManagerBlock();
    } else {
        dispatch_sync(dispatch_get_main_queue(), getUIManagerBlock);
    }

    return result;
}

std::shared_ptr<const facebook::react::ShadowNode> TastoRuntimeHelper::getShadowTreeRoot() {
    NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot called, surfacePresenter_=%p", surfacePresenter_);

    auto uiManager = getUIManager();
    if (!uiManager) {
        NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: UIManager is null");
        return nullptr;
    }

    NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: UIManager available");

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
            NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: Found surface %d", surfaceCount);
            stop = true;
        });

        NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: Total surfaces=%d, rootNode=%s",
              surfaceCount, *rootNodePtr ? "valid" : "null");
    };

    // Shadow tree access should happen on main thread for safety
    if ([NSThread isMainThread]) {
        getRootBlock();
    } else {
        dispatch_sync(dispatch_get_main_queue(), getRootBlock);
    }

    return *rootNodePtr;
}

bool TastoRuntimeHelper::isInitialized() const {
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

bool TastoRuntimeHelper::performTap(float x, float y) {
    __block bool success = false;

    void (^tapBlock)(void) = ^{
        CGPoint point = CGPointMake(x, y);
        NSLog(@"[Tasto] performTap: Tapping at (%.1f, %.1f)", x, y);

        // Find the window that contains the view at this point (handles modals)
        UIWindow* targetWindow = findWindowAtPoint(point);
        if (!targetWindow) {
            NSLog(@"[Tasto] performTap: No window found at point");
            success = false;
            return;
        }

        NSLog(@"[Tasto] performTap: Using window %@ (level %.0f)",
              NSStringFromClass([targetWindow class]), targetWindow.windowLevel);

        // Find the target view at this point
        UIView* hitView = [targetWindow hitTest:point withEvent:nil];
        if (!hitView) {
            NSLog(@"[Tasto] performTap: No view at point");
            success = false;
            return;
        }

        NSLog(@"[Tasto] performTap: Hit view %@", NSStringFromClass([hitView class]));

        // Try Method 1: Use accessibilityActivate if available
        // This is the most reliable way to trigger onPress in React Native
        UIView* activatableView = hitView;
        while (activatableView && activatableView != targetWindow) {
            // Check if this view is accessible and can be activated
            if (activatableView.isAccessibilityElement ||
                activatableView.accessibilityTraits != UIAccessibilityTraitNone) {

                NSLog(@"[Tasto] performTap: Found accessible view: %@ (traits: %llu, identifier: %@)",
                      NSStringFromClass([activatableView class]),
                      (unsigned long long)activatableView.accessibilityTraits,
                      activatableView.accessibilityIdentifier ?: @"nil");

                // Try accessibility activate
                if ([activatableView accessibilityActivate]) {
                    NSLog(@"[Tasto] performTap: accessibilityActivate succeeded!");
                    success = true;
                    return;
                }
            }
            activatableView = activatableView.superview;
        }

        NSLog(@"[Tasto] performTap: accessibilityActivate didn't work, trying touch handler");

        // Try Method 2: Find the RCTSurfaceTouchHandler and call its touch methods directly
        UIGestureRecognizer* touchHandler = findSurfaceTouchHandler(hitView);
        if (touchHandler) {
            NSLog(@"[Tasto] performTap: Found touch handler: %@", NSStringFromClass([touchHandler class]));

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

            NSLog(@"[Tasto] performTap: Calling touchesBegan on touch handler");

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

            NSLog(@"[Tasto] performTap: Calling touchesEnded on touch handler");

            // Call touchesEnded directly on the gesture recognizer
            [touchHandler touchesEnded:touches withEvent:event];

            success = true;
            return;
        }

        NSLog(@"[Tasto] performTap: No touch handler found, trying UIControl");

        // Try Method 3: If it's a UIControl, send actions directly
        UIView* controlView = hitView;
        while (controlView && controlView != targetWindow) {
            if ([controlView isKindOfClass:[UIControl class]]) {
                UIControl* control = (UIControl*)controlView;
                NSLog(@"[Tasto] performTap: Found UIControl: %@", NSStringFromClass([control class]));
                [control sendActionsForControlEvents:UIControlEventTouchUpInside];
                success = true;
                return;
            }
            controlView = controlView.superview;
        }

        NSLog(@"[Tasto] performTap: Falling back to synthetic touch event");

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
        dispatch_sync(dispatch_get_main_queue(), tapBlock);
    }

    return success;
}

bool TastoRuntimeHelper::performTapByTestID(const std::string& testID) {
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
            NSLog(@"[Tasto] performTapByTestID: No key window found");
            success = false;
            return;
        }

        // Find the view by accessibilityIdentifier
        UIView* targetView = findViewByAccessibilityIdentifier(keyWindow, identifier);
        if (!targetView) {
            NSLog(@"[Tasto] performTapByTestID: View with testID '%@' not found", identifier);
            success = false;
            return;
        }

        NSLog(@"[Tasto] performTapByTestID: Found view %@ with testID '%@'",
              NSStringFromClass([targetView class]), identifier);

        // Get the center point in window coordinates
        CGRect frameInWindow = [targetView convertRect:targetView.bounds toView:keyWindow];
        CGPoint centerPoint = CGPointMake(
            CGRectGetMidX(frameInWindow),
            CGRectGetMidY(frameInWindow)
        );

        NSLog(@"[Tasto] performTapByTestID: View frame in window: (%.1f, %.1f, %.1fx%.1f), center: (%.1f, %.1f)",
              frameInWindow.origin.x, frameInWindow.origin.y,
              frameInWindow.size.width, frameInWindow.size.height,
              centerPoint.x, centerPoint.y);

        // Now perform tap at this point
        success = TastoRuntimeHelper::getInstance().performTap(centerPoint.x, centerPoint.y);
    };

    if ([NSThread isMainThread]) {
        tapBlock();
    } else {
        dispatch_sync(dispatch_get_main_queue(), tapBlock);
    }

    return success;
}

bool TastoRuntimeHelper::performTypeText(const std::string& testID, const std::string& text) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];
    NSString* textToType = [NSString stringWithUTF8String:text.c_str()];

    void (^typeBlock)(void) = ^{
        // Find the key window
        UIWindow* keyWindow = findKeyWindow();
        if (!keyWindow) {
            NSLog(@"[Tasto] performTypeText: No key window found");
            success = false;
            return;
        }

        // Find the view by accessibilityIdentifier
        UIView* targetView = findViewByAccessibilityIdentifier(keyWindow, identifier);
        if (!targetView) {
            NSLog(@"[Tasto] performTypeText: View with testID '%@' not found", identifier);
            success = false;
            return;
        }

        NSLog(@"[Tasto] performTypeText: Found view %@ with testID '%@'",
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
            NSLog(@"[Tasto] performTypeText: ComponentView is %@",
                  NSStringFromClass([componentView class]));
        }

        if (textField) {
            NSLog(@"[Tasto] performTypeText: Setting text on UITextField");

            // Make it first responder (focus)
            [textField becomeFirstResponder];

            // Set the text using attributed text to match React Native's internal state
            // React Native uses attributed text internally, so setting plain text may not
            // trigger the proper state updates
            NSDictionary* attributes = textField.defaultTextAttributes ?: @{};
            NSAttributedString* attrStr = [[NSAttributedString alloc] initWithString:textToType
                                                                          attributes:attributes];
            textField.attributedText = attrStr;

            NSLog(@"[Tasto] performTypeText: Set attributed text, actual text now: '%@'", textField.text);

            // Try to find and call textInputDidChange on the component view
            // This is how React Native's Fabric TextInput handles text changes
            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            id delegate = textField.delegate;

            NSLog(@"[Tasto] performTypeText: TextField delegate class: %@",
                  delegate ? NSStringFromClass([delegate class]) : @"nil");

            // The component view (superview) should be RCTTextInputComponentView
            // which implements the textInputDidChange method
            UIView* parentView = componentView;
            if (parentView && [parentView respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Tasto] performTypeText: Calling textInputDidChange on parent view");

                // First, trigger the text field's editing changed action to notify any observers
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];

                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [parentView performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop

                // Allow React's async update to process
                [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
                NSLog(@"[Tasto] performTypeText: After delay, text field text: '%@'", textField.text);
            } else if (delegate && [delegate respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Tasto] performTypeText: Calling textInputDidChange on delegate");
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [delegate performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            } else {
                NSLog(@"[Tasto] performTypeText: No textInputDidChange found, trying fallback");
                // Fallback to sendActionsForControlEvents
                [textField sendActionsForControlEvents:UIControlEventEditingChanged];

                // Also try calling textFieldDidChange on the delegate
                SEL textFieldDidChangeSel = NSSelectorFromString(@"textFieldDidChange:");
                if (delegate && [delegate respondsToSelector:textFieldDidChangeSel]) {
                    NSLog(@"[Tasto] performTypeText: Calling textFieldDidChange on delegate");
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    [delegate performSelector:textFieldDidChangeSel withObject:textField];
                    #pragma clang diagnostic pop
                }
            }

            success = true;
        } else if (textView) {
            NSLog(@"[Tasto] performTypeText: Setting text on UITextView");

            // Make it first responder (focus)
            [textView becomeFirstResponder];

            // Set the text directly
            textView.text = textToType;

            // Try to call textInputDidChange on the delegate
            SEL textInputDidChangeSel = NSSelectorFromString(@"textInputDidChange");
            id delegate = textView.delegate;
            if (delegate && [delegate respondsToSelector:textInputDidChangeSel]) {
                NSLog(@"[Tasto] performTypeText: Calling textInputDidChange on delegate");
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [delegate performSelector:textInputDidChangeSel];
                #pragma clang diagnostic pop
            } else if (delegate && [delegate respondsToSelector:@selector(textViewDidChange:)]) {
                [delegate performSelector:@selector(textViewDidChange:) withObject:textView];
            }

            success = true;
        } else {
            NSLog(@"[Tasto] performTypeText: No UITextField or UITextView found in view");
            success = false;
        }
    };

    if ([NSThread isMainThread]) {
        typeBlock();
    } else {
        dispatch_sync(dispatch_get_main_queue(), typeBlock);
    }

    return success;
}

bool TastoRuntimeHelper::performClearText(const std::string& testID) {
    return performTypeText(testID, "");
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

bool TastoRuntimeHelper::performScroll(const std::string& testID, float deltaX, float deltaY) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];

    void (^scrollBlock)(void) = ^{
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
            NSLog(@"[Tasto] performScroll: No key window found");
            success = false;
            return;
        }

        UIView* view = findViewByAccessibilityIdentifier(keyWindow, identifier);
        if (!view) {
            NSLog(@"[Tasto] performScroll: View not found for testID: %@", identifier);
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
            NSLog(@"[Tasto] performScroll: No UIScrollView found for testID: %@", identifier);
            success = false;
            return;
        }

        NSLog(@"[Tasto] performScroll: Found scroll view, current offset: (%.1f, %.1f)",
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

        NSLog(@"[Tasto] performScroll: Scrolling to offset: (%.1f, %.1f)", newOffset.x, newOffset.y);

        // Perform the scroll
        [scrollView setContentOffset:newOffset animated:YES];

        success = true;
    };

    if ([NSThread isMainThread]) {
        scrollBlock();
    } else {
        dispatch_sync(dispatch_get_main_queue(), scrollBlock);
    }

    return success;
}

bool TastoRuntimeHelper::performScrollTo(const std::string& testID, float x, float y, bool animated) {
    __block bool success = false;
    NSString* identifier = [NSString stringWithUTF8String:testID.c_str()];

    void (^scrollBlock)(void) = ^{
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
            NSLog(@"[Tasto] performScrollTo: No key window found");
            success = false;
            return;
        }

        UIView* view = findViewByAccessibilityIdentifier(keyWindow, identifier);
        if (!view) {
            NSLog(@"[Tasto] performScrollTo: View not found for testID: %@", identifier);
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
            NSLog(@"[Tasto] performScrollTo: No UIScrollView found for testID: %@", identifier);
            success = false;
            return;
        }

        NSLog(@"[Tasto] performScrollTo: Scrolling to (%.1f, %.1f) animated=%d", x, y, animated);

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
        dispatch_sync(dispatch_get_main_queue(), scrollBlock);
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

bool TastoRuntimeHelper::isAlertPresent() {
    __block bool result = false;

    void (^block)(void) = ^{
        result = (findPresentedAlertController() != nil);
        NSLog(@"[Tasto] isAlertPresent: %@", result ? @"YES" : @"NO");
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }

    return result;
}

std::string TastoRuntimeHelper::getAlertText() {
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
            NSLog(@"[Tasto] getAlertText: %@", text);
        } else {
            NSLog(@"[Tasto] getAlertText: No alert found");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }

    return result;
}

std::vector<std::string> TastoRuntimeHelper::getAlertButtons() {
    __block std::vector<std::string> result;

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (alert) {
            for (UIAlertAction* action in alert.actions) {
                if (action.title) {
                    result.push_back([action.title UTF8String]);
                    NSLog(@"[Tasto] getAlertButtons: Found button '%@'", action.title);
                }
            }
        } else {
            NSLog(@"[Tasto] getAlertButtons: No alert found");
        }
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }

    return result;
}

// Helper function to find and tap a button by title (recursive)
static void findAndTapButtonWithTitle(NSString* title, UIView* view) {
    if ([view isKindOfClass:[UIButton class]]) {
        UIButton* button = (UIButton*)view;
        NSString* buttonTitle = [button titleForState:UIControlStateNormal];
        if ([buttonTitle isEqualToString:title]) {
            [button sendActionsForControlEvents:UIControlEventTouchUpInside];
            return;
        }
    }

    for (UIView* subview in [view subviews]) {
        findAndTapButtonWithTitle(title, subview);
    }
}

bool TastoRuntimeHelper::tapAlertButton(const std::string& buttonText) {
    __block bool success = false;
    NSString* targetButtonText = [NSString stringWithUTF8String:buttonText.c_str()];

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) {
            NSLog(@"[Tasto] tapAlertButton: No alert found");
            return;
        }

        // Find the action with matching title
        for (UIAlertAction* action in alert.actions) {
            if ([action.title isEqualToString:targetButtonText]) {
                NSLog(@"[Tasto] tapAlertButton: Found button '%@', triggering", targetButtonText);

                // Dismiss the alert and call the action's handler
                // We need to use a private API to get the handler since UIAlertAction doesn't expose it
                // Instead, we'll dismiss by tapping the button's view

                // Find the button in the alert's view hierarchy
                UIView* alertView = alert.view;
                if (alertView.superview) {
                    alertView = alertView.superview;
                }

                // Try to find and tap the button by its title
                for (UIView* subview in [alertView subviews]) {
                    findAndTapButtonWithTitle(targetButtonText, subview);
                }

                // Alternative: Dismiss the alert programmatically and invoke the handler
                // This is more reliable since it doesn't depend on finding the button view
                [alert dismissViewControllerAnimated:NO completion:^{
                    // The action handler should be called as part of the dismissal
                }];

                // Directly invoke the action handler using KVC if available
                SEL handlerSel = NSSelectorFromString(@"handler");
                if ([action respondsToSelector:handlerSel]) {
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    void (^handler)(UIAlertAction*) = [action performSelector:handlerSel];
                    #pragma clang diagnostic pop

                    if (handler) {
                        NSLog(@"[Tasto] tapAlertButton: Invoking handler for '%@'", targetButtonText);
                        handler(action);
                    }
                }

                success = true;
                return;
            }
        }

        NSLog(@"[Tasto] tapAlertButton: Button '%@' not found", targetButtonText);
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }

    return success;
}

bool TastoRuntimeHelper::dismissAlert() {
    __block bool success = false;

    void (^block)(void) = ^{
        UIAlertController* alert = findPresentedAlertController();
        if (!alert) {
            NSLog(@"[Tasto] dismissAlert: No alert found");
            return;
        }

        NSLog(@"[Tasto] dismissAlert: Dismissing alert");

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

        if (targetAction) {
            // Try to invoke the handler
            SEL handlerSel = NSSelectorFromString(@"handler");
            if ([targetAction respondsToSelector:handlerSel]) {
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                void (^handler)(UIAlertAction*) = [targetAction performSelector:handlerSel];
                #pragma clang diagnostic pop

                if (handler) {
                    handler(targetAction);
                }
            }
        }

        [alert dismissViewControllerAnimated:NO completion:nil];
        success = true;
    };

    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }

    return success;
}

} // namespace tasto

// Objective-C helper for setting the surface presenter
extern "C" void TastoSetSurfacePresenter(RCTSurfacePresenter* presenter) {
    tasto::TastoRuntimeHelper::getInstance().setSurfacePresenter((__bridge void*)presenter);
}

// Logging helper for C++ code
extern "C" void TastoLogMessage(const char* message) {
    NSLog(@"%s", message);
}
