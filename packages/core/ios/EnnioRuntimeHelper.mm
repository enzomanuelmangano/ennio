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

} // namespace ennio

// Objective-C helper for setting the surface presenter
extern "C" void EnnioSetSurfacePresenter(RCTSurfacePresenter* presenter) {
    ennio::EnnioRuntimeHelper::getInstance().setSurfacePresenter((__bridge void*)presenter);
}

// Logging helper for C++ code
extern "C" void EnnioLogMessage(const char* message) {
    NSLog(@"%s", message);
}
