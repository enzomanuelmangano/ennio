//
// EnnioAutoInit.mm
// Automatic initialization of Ennio by hooking into React Native setup
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import "EnnioRuntimeHelper.h"

#if __has_include(<React/RCTSurfacePresenter.h>)
#import <React/RCTSurfacePresenter.h>
#endif

#include <jsi/jsi.h>
#include <functional>
#include "../cpp/HybridEnnio.hpp"

#if __has_include(<ReactCommon/RCTInstance.h>)
#import <ReactCommon/RCTInstance.h>
#define ENNIO_HAVE_RCTINSTANCE 1
#endif

static const int kEnnioDefaultPort = 9876;

// Flag to track if Ennio has been initialized
static BOOL _ennioInitialized = NO;

/**
 * Hook into RCTHost's start method to capture the surface presenter
 */
@interface EnnioAutoInit : NSObject
@end

@implementation EnnioAutoInit

+ (void)load {
    NSLog(@"[Ennio] EnnioAutoInit +load called");

    // Try to swizzle RCTHost's start method
    Class hostClass = NSClassFromString(@"RCTHost");
    if (!hostClass) {
        NSLog(@"[Ennio] RCTHost class not found, trying alternative...");

        // Try RCTFabricSurface's start method as alternative
        Class surfaceClass = NSClassFromString(@"RCTFabricSurface");
        if (surfaceClass) {
            [self swizzleFabricSurfaceStart:surfaceClass];
        } else {
            NSLog(@"[Ennio] No suitable class found for auto-init");
        }
        return;
    }

    NSLog(@"[Ennio] Found RCTHost class, setting up swizzling...");

    SEL originalSelector = @selector(start);
    SEL swizzledSelector = @selector(ennio_start);

    Method originalMethod = class_getInstanceMethod(hostClass, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);

    if (!originalMethod) {
        NSLog(@"[Ennio] Could not find RCTHost start method");
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
        NSLog(@"[Ennio] Could not add swizzled method to RCTHost");
        return;
    }

    // Exchange implementations
    Method newSwizzledMethod = class_getInstanceMethod(hostClass, swizzledSelector);
    method_exchangeImplementations(originalMethod, newSwizzledMethod);
    NSLog(@"[Ennio] RCTHost.start swizzle installed successfully");
}

+ (void)swizzleFabricSurfaceStart:(Class)surfaceClass {
    SEL originalSelector = @selector(start);
    SEL swizzledSelector = @selector(ennio_surfaceStart);

    Method originalMethod = class_getInstanceMethod(surfaceClass, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);

    if (!originalMethod) {
        NSLog(@"[Ennio] Could not find RCTFabricSurface start method");
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
        NSLog(@"[Ennio] RCTFabricSurface.start swizzle installed successfully");
    }
}

// Swizzled RCTHost start method
- (void)ennio_start {
    NSLog(@"[Ennio] RCTHost.start called");

    // Call original implementation
    [self ennio_start];

    // Pure-native bootstrap: pull RCTInstance from RCTHost's `_instance`
    // ivar, ask it to run a block on the JS thread once the runtime is
    // ready. Inside that block we have a `jsi::Runtime&` — capture it,
    // install the fiber walker, construct HybridEnnio, start the WS
    // server. After this, the user's app never has to import
    // `@ennio/core`; the package autolinks via Pod and bootstraps
    // entirely from native.
    Ivar instanceIvar = class_getInstanceVariable([self class], "_instance");
    if (instanceIvar) {
        id rctInstance = object_getIvar(self, instanceIvar);
#ifdef ENNIO_HAVE_RCTINSTANCE
        if ([rctInstance isKindOfClass:[RCTInstance class]]) {
            __strong RCTInstance* strongInstance = (RCTInstance*)rctInstance;
            // Hand a JS-thread executor to HybridEnnio. The WS-server
            // thread will call this when it needs to invoke the React
            // fiber walker on the JS thread.
            margelo::nitro::ennio::HybridEnnio::JSThreadExecutor exec =
                [strongInstance](std::function<void(facebook::jsi::Runtime&)>&& fn) {
                    [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(fn)];
                };
            margelo::nitro::ennio::HybridEnnio::setJSThreadExecutor(std::move(exec));

            // Bootstrap (capture runtime, install fiber walker, start
            // WS server) once the JS thread is ready. Same RCTInstance
            // method delivers our C++ lambda onto the JS thread.
            std::function<void(facebook::jsi::Runtime&)> boot =
                [](facebook::jsi::Runtime& rt) {
                    margelo::nitro::ennio::HybridEnnio::nativeBootstrap(rt, kEnnioDefaultPort);
                };
            [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(boot)];
            NSLog(@"[Ennio] Scheduled nativeBootstrap on JS thread");
        } else {
            NSLog(@"[Ennio] _instance is not an RCTInstance (got %@)", [rctInstance class]);
        }
#else
        NSLog(@"[Ennio] RCTInstance.h not available — falling back to JS-side bootstrap");
        (void)rctInstance;
#endif
    } else {
        NSLog(@"[Ennio] Could not find RCTHost._instance ivar");
    }

    // Get surface presenter from RCTHost
    if (!_ennioInitialized) {
        // Use performSelector to avoid compile-time dependency
        SEL surfacePresenterSel = @selector(surfacePresenter);
        if ([self respondsToSelector:surfacePresenterSel]) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            id surfacePresenter = [self performSelector:surfacePresenterSel];
            #pragma clang diagnostic pop

            if (surfacePresenter) {
                EnnioSetSurfacePresenter((__bridge RCTSurfacePresenter *)(__bridge void *)surfacePresenter);
                _ennioInitialized = YES;
                NSLog(@"[Ennio] Surface presenter captured from RCTHost");
            } else {
                NSLog(@"[Ennio] RCTHost.surfacePresenter returned nil");
            }
        } else {
            NSLog(@"[Ennio] RCTHost does not respond to surfacePresenter");
        }
    }
}

// Swizzled RCTFabricSurface start method (alternative path)
- (void)ennio_surfaceStart {
    NSLog(@"[Ennio] RCTFabricSurface.start called");

    // Call original implementation
    [self ennio_surfaceStart];

    // Try to get surface presenter from the surface
    if (!_ennioInitialized) {
        // The surface should have access to its presenter
        // This is a fallback - not all surfaces expose this
        NSLog(@"[Ennio] Attempting to find surface presenter from RCTFabricSurface...");

        // Check if there's a presenter property
        SEL presenterSel = @selector(surfacePresenter);
        if ([self respondsToSelector:presenterSel]) {
            #pragma clang diagnostic push
            #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
            id presenter = [self performSelector:presenterSel];
            #pragma clang diagnostic pop

            if (presenter) {
                EnnioSetSurfacePresenter((__bridge RCTSurfacePresenter *)(__bridge void *)presenter);
                _ennioInitialized = YES;
                NSLog(@"[Ennio] Surface presenter captured from RCTFabricSurface");
            }
        }
    }
}

@end
