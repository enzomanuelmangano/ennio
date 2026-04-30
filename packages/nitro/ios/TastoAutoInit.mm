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

// Flag to track if Tasto has been initialized
static BOOL _tastoInitialized = NO;

/**
 * Hook into RCTHost's start method to capture the surface presenter
 */
@interface TastoAutoInit : NSObject
@end

@implementation TastoAutoInit

+ (void)load {
    NSLog(@"[Tasto] TastoAutoInit +load called");

    // Try to swizzle RCTHost's start method
    Class hostClass = NSClassFromString(@"RCTHost");
    if (!hostClass) {
        NSLog(@"[Tasto] RCTHost class not found, trying alternative...");

        // Try RCTFabricSurface's start method as alternative
        Class surfaceClass = NSClassFromString(@"RCTFabricSurface");
        if (surfaceClass) {
            [self swizzleFabricSurfaceStart:surfaceClass];
        } else {
            NSLog(@"[Tasto] No suitable class found for auto-init");
        }
        return;
    }

    NSLog(@"[Tasto] Found RCTHost class, setting up swizzling...");

    SEL originalSelector = @selector(start);
    SEL swizzledSelector = @selector(tasto_start);

    Method originalMethod = class_getInstanceMethod(hostClass, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);

    if (!originalMethod) {
        NSLog(@"[Tasto] Could not find RCTHost start method");
        return;
    }

    // Add swizzled method to RCTHost class
    BOOL didAddMethod = class_addMethod(
        hostClass,
        swizzledSelector,
        method_getImplementation(swizzledMethod),
        method_getTypeEncoding(swizzledMethod)
    );

    if (!didAddMethod) {
        NSLog(@"[Tasto] Could not add swizzled method to RCTHost");
        return;
    }

    // Exchange implementations
    Method newSwizzledMethod = class_getInstanceMethod(hostClass, swizzledSelector);
    method_exchangeImplementations(originalMethod, newSwizzledMethod);
    NSLog(@"[Tasto] RCTHost.start swizzle installed successfully");
}

+ (void)swizzleFabricSurfaceStart:(Class)surfaceClass {
    SEL originalSelector = @selector(start);
    SEL swizzledSelector = @selector(tasto_surfaceStart);

    Method originalMethod = class_getInstanceMethod(surfaceClass, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);

    if (!originalMethod) {
        NSLog(@"[Tasto] Could not find RCTFabricSurface start method");
        return;
    }

    BOOL didAddMethod = class_addMethod(
        surfaceClass,
        swizzledSelector,
        method_getImplementation(swizzledMethod),
        method_getTypeEncoding(swizzledMethod)
    );

    if (didAddMethod) {
        Method newSwizzledMethod = class_getInstanceMethod(surfaceClass, swizzledSelector);
        method_exchangeImplementations(originalMethod, newSwizzledMethod);
        NSLog(@"[Tasto] RCTFabricSurface.start swizzle installed successfully");
    }
}

// Swizzled RCTHost start method
- (void)tasto_start {
    NSLog(@"[Tasto] RCTHost.start called");

    // Call original implementation
    [self tasto_start];

    // Get surface presenter from RCTHost
    if (!_tastoInitialized) {
        // Use performSelector to avoid compile-time dependency
        SEL surfacePresenterSel = @selector(surfacePresenter);
        if ([self respondsToSelector:surfacePresenterSel]) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            id surfacePresenter = [self performSelector:surfacePresenterSel];
            #pragma clang diagnostic pop

            if (surfacePresenter) {
                TastoSetSurfacePresenter((__bridge RCTSurfacePresenter *)(__bridge void *)surfacePresenter);
                _tastoInitialized = YES;
                NSLog(@"[Tasto] Surface presenter captured from RCTHost");
            } else {
                NSLog(@"[Tasto] RCTHost.surfacePresenter returned nil");
            }
        } else {
            NSLog(@"[Tasto] RCTHost does not respond to surfacePresenter");
        }
    }
}

// Swizzled RCTFabricSurface start method (alternative path)
- (void)tasto_surfaceStart {
    NSLog(@"[Tasto] RCTFabricSurface.start called");

    // Call original implementation
    [self tasto_surfaceStart];

    // Try to get surface presenter from the surface
    if (!_tastoInitialized) {
        // The surface should have access to its presenter
        // This is a fallback - not all surfaces expose this
        NSLog(@"[Tasto] Attempting to find surface presenter from RCTFabricSurface...");

        // Check if there's a presenter property
        SEL presenterSel = @selector(surfacePresenter);
        if ([self respondsToSelector:presenterSel]) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            id presenter = [self performSelector:presenterSel];
            #pragma clang diagnostic pop

            if (presenter) {
                TastoSetSurfacePresenter((__bridge RCTSurfacePresenter *)(__bridge void *)presenter);
                _tastoInitialized = YES;
                NSLog(@"[Tasto] Surface presenter captured from RCTFabricSurface");
            }
        }
    }
}

@end
