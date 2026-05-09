//
// EnnioAutoInit.mm
// Automatic initialization of Ennio by hooking into React Native setup
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import "EnnioRuntimeHelper.h"
#import "EnnioDebugBanner.h"

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

// Distribution channel detection. Ennio is a dev / QA tool and must
// refuse to start on App Store production or Enterprise builds — the
// build-time `ENNIO_ENABLED` gate is necessary but not sufficient,
// because a single CI misconfiguration could ship the pod.
typedef NS_ENUM(NSInteger, EnnioDistribution) {
    EnnioDistDev,
    EnnioDistAdHoc,
    EnnioDistTestFlight,
    EnnioDistAppStore,
    EnnioDistEnterprise,
};

static EnnioDistribution ennioDetectDistribution(void) {
    NSURL* receiptURL = [NSBundle mainBundle].appStoreReceiptURL;
    NSString* receiptName = receiptURL.lastPathComponent;

    NSString* profilePath = [[NSBundle mainBundle] pathForResource:@"embedded" ofType:@"mobileprovision"];
    NSData* profileData = profilePath ? [NSData dataWithContentsOfFile:profilePath] : nil;
    // .mobileprovision is a CMS-signed blob; the embedded plist XML is
    // ASCII inside binary noise. Latin-1 makes containsString: work
    // without decode failures on the surrounding bytes.
    NSString* profileStr = profileData
        ? [[NSString alloc] initWithData:profileData encoding:NSISOLatin1StringEncoding]
        : nil;

    BOOL provisionsAllDevices = [profileStr containsString:@"<key>ProvisionsAllDevices</key>"];
    BOOL hasProvisionedDevices = [profileStr containsString:@"<key>ProvisionedDevices</key>"];
    BOOL hasProfile = (profileStr.length > 0);

    // Enterprise: profile claims to provision all devices.
    if (provisionsAllDevices) return EnnioDistEnterprise;

    // Receipt-based channel detection (the device chose this at install
    // time, not the build).
    if ([receiptName isEqualToString:@"receipt"]) return EnnioDistAppStore;
    if ([receiptName isEqualToString:@"sandboxReceipt"]) return EnnioDistTestFlight;

    // Ad-Hoc: profile names a specific device list.
    if (hasProvisionedDevices) return EnnioDistAdHoc;

    // App Store distribution profile: no ProvisionedDevices, no
    // ProvisionsAllDevices, and no receipt yet. This catches the
    // sideloaded-production-IPA edge case where the build is signed
    // with the App Store profile but Xcode/Configurator pushed it
    // straight to a device without going through TestFlight or App
    // Store, so no receipt was fetched.
    if (hasProfile && !hasProvisionedDevices && !provisionsAllDevices) return EnnioDistAppStore;

    // Simulator and Xcode-attached debug builds have no embedded
    // profile at all. Treat as Dev.
    return EnnioDistDev;
}

static NSString* ennioDistributionName(EnnioDistribution d) {
    switch (d) {
        case EnnioDistDev:        return @"Development";
        case EnnioDistAdHoc:      return @"Ad-Hoc";
        case EnnioDistTestFlight: return @"TestFlight";
        case EnnioDistAppStore:   return @"App Store";
        case EnnioDistEnterprise: return @"Enterprise";
    }
}

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

    // Distribution gate. Even if the build-time gate slipped and Ennio
    // is linked into an App Store / Enterprise binary, refuse to start
    // the WS server, fiber walker, or banner. This is the runtime
    // backstop to the `ENNIO_ENABLED=1` plugin gate.
    EnnioDistribution dist = ennioDetectDistribution();
    if (dist == EnnioDistAppStore || dist == EnnioDistEnterprise) {
        NSLog(@"[Ennio] REFUSING to start: %@ distribution detected. "
              @"Ennio must never run in App Store or Enterprise builds. "
              @"Your build pipeline is leaking a remote-control surface — fix it.",
              ennioDistributionName(dist));
        return;
    }
    NSLog(@"[Ennio] Distribution: %@ — starting", ennioDistributionName(dist));

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

            // Loud, greppable announce. If this line ever shows up in
            // Console.app on a non-dev device, the build pipeline has
            // leaked Ennio into a build it shouldn't be in.
            NSLog(@"[Ennio] WebSocket server listening on 127.0.0.1:%d (distribution: %@) — "
                  @"if you see this in production, your build pipeline is broken.",
                  kEnnioDefaultPort, ennioDistributionName(dist));

            // Show the top-right "E2E" ribbon. Tied to the same gate as
            // the WS server: if Ennio is in this build, the ribbon
            // shows; if Ennio isn't (ENNIO_ENABLED unset / =0 at
            // prebuild), this whole file isn't compiled in.
            [EnnioDebugBanner show];
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
