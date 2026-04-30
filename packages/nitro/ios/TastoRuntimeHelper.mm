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
    // Try to find RCTHost instances
    Class hostClass = NSClassFromString(@"RCTHost");
    if (hostClass) {
        // Use runtime introspection to find instances
        // This is a fallback - ideally the swizzling should work
        NSLog(@"[Tasto] Searching for RCTHost instances...");

        // Try to access through the app delegate's factory
        UIApplication* app = [UIApplication sharedApplication];
        id appDelegate = app.delegate;

        // Check if app delegate has reactNativeFactory property
        SEL factorySel = @selector(reactNativeFactory);
        if ([appDelegate respondsToSelector:factorySel]) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            id factory = [appDelegate performSelector:factorySel];
            #pragma clang diagnostic pop

            if (factory) {
                NSLog(@"[Tasto] Found reactNativeFactory: %@", factory);

                // Try to get host from factory
                SEL hostSel = @selector(reactHost);
                if ([factory respondsToSelector:hostSel]) {
                    #pragma clang diagnostic push
                    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                    id host = [factory performSelector:hostSel];
                    #pragma clang diagnostic pop

                    if (host) {
                        NSLog(@"[Tasto] Found RCTHost: %@", host);

                        SEL presenterSel = @selector(surfacePresenter);
                        if ([host respondsToSelector:presenterSel]) {
                            #pragma clang diagnostic push
                            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                            id presenter = [host performSelector:presenterSel];
                            #pragma clang diagnostic pop

                            if (presenter) {
                                NSLog(@"[Tasto] Found surfacePresenter: %@", presenter);
                                return (__bridge RCTSurfacePresenter *)(__bridge void *)presenter;
                            }
                        }
                    }
                }
            }
        }
    }

    return nil;
}

std::shared_ptr<facebook::react::UIManager> TastoRuntimeHelper::getUIManager() {
    NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager called, surfacePresenter_=%p", surfacePresenter_);

    // If we don't have a surface presenter, try to find one
    if (!surfacePresenter_) {
        NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: surfacePresenter_ is null, searching...");

        RCTSurfacePresenter* found = findSurfacePresenterInRuntime();
        if (found) {
            surfacePresenter_ = (__bridge void*)found;
            NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: Found surface presenter via runtime search");
        } else {
            NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: Could not find surface presenter");
            return nullptr;
        }
    }

    RCTSurfacePresenter* presenter = (__bridge RCTSurfacePresenter*)surfacePresenter_;
    NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: presenter=%@", presenter);

    RCTScheduler* scheduler = [presenter scheduler];
    NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: scheduler=%@", scheduler);

    if (!scheduler) {
        NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: scheduler is null");
        return nullptr;
    }

    auto uiManager = [scheduler uiManager];
    NSLog(@"[Tasto] TastoRuntimeHelper::getUIManager: uiManager=%s", uiManager ? "valid" : "null");

    return uiManager;
}

std::shared_ptr<const facebook::react::ShadowNode> TastoRuntimeHelper::getShadowTreeRoot() {
    NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot called, surfacePresenter_=%p", surfacePresenter_);

    auto uiManager = getUIManager();
    if (!uiManager) {
        NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: UIManager is null");
        return nullptr;
    }

    NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: UIManager available");

    // Get the shadow tree registry and enumerate to find the first surface
    auto& shadowTreeRegistry = uiManager->getShadowTreeRegistry();
    std::shared_ptr<const facebook::react::ShadowNode> rootNode = nullptr;
    int surfaceCount = 0;

    shadowTreeRegistry.enumerate([&](const facebook::react::ShadowTree& shadowTree, bool& stop) {
        surfaceCount++;
        // Get the root from the first surface we find
        rootNode = shadowTree.getCurrentRevision().rootShadowNode;
        NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: Found surface %d", surfaceCount);
        stop = true;
    });

    NSLog(@"[Tasto] TastoRuntimeHelper::getShadowTreeRoot: Total surfaces=%d, rootNode=%s",
          surfaceCount, rootNode ? "valid" : "null");

    return rootNode;
}

bool TastoRuntimeHelper::isInitialized() const {
    return surfacePresenter_ != nullptr;
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

        // Find the target view
        UIView* targetView = [targetWindow hitTest:point withEvent:nil];
        if (!targetView) {
            NSLog(@"[Tasto] performTap: No view at point");
            success = false;
            return;
        }

        NSLog(@"[Tasto] performTap: Found view %@", NSStringFromClass([targetView class]));

        // Log the view hierarchy for debugging
        UIView* debugView = targetView;
        int depth = 0;
        while (debugView && depth < 10) {
            NSLog(@"[Tasto] performTap: View hierarchy[%d]: %@ (gestureRecognizers: %lu)",
                  depth, NSStringFromClass([debugView class]),
                  (unsigned long)debugView.gestureRecognizers.count);
            debugView = debugView.superview;
            depth++;
        }

        // For non-RCT views (like Modal content), the shadow tree coordinates may not match
        // the native view positions. Instead, just send the touch to the original hitTest target
        // and let UIKit handle the event routing.
        //
        // The issue is that React Native Modal creates views with different coordinate systems
        // between the shadow tree and native views. Don't try to find nested RCT views - just
        // use the UIView that hitTest returned and let gesture recognizers handle it.
        if (![NSStringFromClass([targetView class]) hasPrefix:@"RCT"]) {
            NSLog(@"[Tasto] performTap: Hit non-RCT view %@, using direct touch", NSStringFromClass([targetView class]));
            // Keep targetView as-is (the UIView from hitTest)
        }

        // Create synthetic UITouch
        UITouch* touch = [[UITouch alloc] init];

        // Get current timestamp
        NSTimeInterval timestamp = [[NSProcessInfo processInfo] systemUptime];

        // Set up touch properties using private APIs
        [touch setWindow:targetWindow];
        [touch setView:targetView];
        [touch setPhase:UITouchPhaseBegan];
        [touch setTapCount:1];
        [touch _setLocationInWindow:point resetPrevious:YES];
        [touch setTimestamp:timestamp];
        [touch _setIsFirstTouchForView:YES];

        // Get the application's touch event
        UIApplication* app = [UIApplication sharedApplication];
        UIEvent* event = [app _touchesEvent];
        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];

        NSLog(@"[Tasto] performTap: Sending touchesBegan to window: %@ (level: %.0f)",
              NSStringFromClass([targetWindow class]), targetWindow.windowLevel);

        // Send touch began
        [app sendEvent:event];

        NSLog(@"[Tasto] performTap: touchesBegan sent successfully");

        // Update touch for end phase after a brief delay
        // Using usleep on main thread is acceptable for testing frameworks
        usleep(50000); // 50ms

        // Update touch for end phase
        [touch setPhase:UITouchPhaseEnded];
        [touch setTimestamp:[[NSProcessInfo processInfo] systemUptime]];
        [touch _setLocationInWindow:point resetPrevious:NO];

        // Clear and re-add the touch
        [event _clearTouches];
        [event _addTouch:touch forDelayedDelivery:NO];

        NSLog(@"[Tasto] performTap: Sending touchesEnded");

        // Send touch ended
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

        if (textField) {
            NSLog(@"[Tasto] performTypeText: Setting text on UITextField");

            // Make it first responder (focus)
            [textField becomeFirstResponder];

            // Set the text directly
            textField.text = textToType;

            // Notify delegate of the change
            [textField sendActionsForControlEvents:UIControlEventEditingChanged];

            success = true;
        } else if (textView) {
            NSLog(@"[Tasto] performTypeText: Setting text on UITextView");

            // Make it first responder (focus)
            [textView becomeFirstResponder];

            // Set the text directly
            textView.text = textToType;

            // Notify delegate of the change
            if (textView.delegate && [textView.delegate respondsToSelector:@selector(textViewDidChange:)]) {
                [textView.delegate textViewDidChange:textView];
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

} // namespace tasto

// Objective-C helper for setting the surface presenter
extern "C" void TastoSetSurfacePresenter(RCTSurfacePresenter* presenter) {
    tasto::TastoRuntimeHelper::getInstance().setSurfacePresenter((__bridge void*)presenter);
}

// Logging helper for C++ code
extern "C" void TastoLogMessage(const char* message) {
    NSLog(@"%s", message);
}
