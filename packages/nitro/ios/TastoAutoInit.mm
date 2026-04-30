//
// TastoAutoInit.mm
// Automatic initialization of Tasto by hooking into React Native setup
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import "TastoRuntimeHelper.h"

#if __has_include(<React/RCTSurfacePresenter.h>)
#import <React/RCTSurfacePresenter.h>
#endif

// Store a reference to surface presenters as they're created
static NSHashTable<id> *_surfacePresenters = nil;
static dispatch_once_t _onceToken;

/**
 * Hook into RCTSurfacePresenter initialization to capture instances
 */
@interface TastoAutoInit : NSObject
@end

@implementation TastoAutoInit

+ (void)load {
    NSLog(@"[Tasto] TastoAutoInit +load called");
    fprintf(stderr, "[Tasto] TastoAutoInit +load called\n");

    dispatch_once(&_onceToken, ^{
        _surfacePresenters = [NSHashTable weakObjectsHashTable];
    });

    // Try to swizzle RCTSurfacePresenter's init method
    Class surfacePresenterClass = NSClassFromString(@"RCTSurfacePresenter");
    if (!surfacePresenterClass) {
        NSLog(@"[Tasto] RCTSurfacePresenter class not found, auto-init disabled");
        fprintf(stderr, "[Tasto] RCTSurfacePresenter class not found\n");
        return;
    }

    NSLog(@"[Tasto] Found RCTSurfacePresenter class, setting up swizzling...");

    SEL originalSelector = @selector(initWithContextContainer:runtimeExecutor:bridgelessBindingsExecutor:);
    SEL swizzledSelector = @selector(tasto_initWithContextContainer:runtimeExecutor:bridgelessBindingsExecutor:);

    Method originalMethod = class_getInstanceMethod(surfacePresenterClass, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);

    if (!originalMethod) {
        NSLog(@"[Tasto] Could not find original init method, auto-init disabled");
        return;
    }

    // Add swizzled method to RCTSurfacePresenter class
    BOOL didAddMethod = class_addMethod(
        surfacePresenterClass,
        swizzledSelector,
        method_getImplementation(swizzledMethod),
        method_getTypeEncoding(swizzledMethod)
    );

    if (!didAddMethod) {
        NSLog(@"[Tasto] Could not add swizzled method, auto-init disabled");
        return;
    }

    // Get the newly added method
    Method newSwizzledMethod = class_getInstanceMethod(surfacePresenterClass, swizzledSelector);

    // Exchange implementations
    method_exchangeImplementations(originalMethod, newSwizzledMethod);
    NSLog(@"[Tasto] Auto-init installed successfully");
}

// This will be called as the original init method after swizzling
- (instancetype)tasto_initWithContextContainer:(void *)contextContainer
                               runtimeExecutor:(void *)runtimeExecutor
                    bridgelessBindingsExecutor:(void *)bridgelessBindingsExecutor {
    // Call original implementation (which is now our swizzled selector)
    id result = [self tasto_initWithContextContainer:contextContainer
                                     runtimeExecutor:runtimeExecutor
                          bridgelessBindingsExecutor:bridgelessBindingsExecutor];

    if (result) {
        // Store reference and initialize Tasto
        [_surfacePresenters addObject:result];
        TastoSetSurfacePresenter((__bridge RCTSurfacePresenter *)(__bridge void *)result);
        NSLog(@"[Tasto] Surface presenter captured and initialized");
    }

    return result;
}

@end
