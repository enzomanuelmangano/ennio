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
#include "../cpp/EnnioControlSocket.h"

#if __has_include(<ReactCommon/RCTInstance.h>)
#import <ReactCommon/RCTInstance.h>
#define ENNIO_HAVE_RCTINSTANCE 1
#endif

// Reload-aware bootstrap: in addition to swizzling `RCTHost.start`
// (fires once at process boot), swizzle `RCTHost.instance:didInitializeRuntime:`
// which RN calls EVERY time a new `jsi::Runtime` is created — initial
// boot plus every reload triggered via `RCTTriggerReloadCommandListeners`
// (`DevSettings.reload`, shake → Reload, the public CDP path, etc.).
// Without this, `__ennioDispatch` disappears from JS after every reload
// and the CLI's next eval errors with "Property '__ennioDispatch'
// doesn't exist".
//
// We tried `host.runtimeDelegate` first (KVC readback confirmed the
// delegate was set), but the forwarding method `instance:didInitializeRuntime:`
// silently dropped the call in some RN configurations. Swizzling that
// method directly bypasses the forwarder. Same trampoline pattern as
// `ennio_start`: store original IMP, install ours, on call run the
// post-init bootstrap then chain to the original.

// Flag to track if Ennio has been initialized
static BOOL _ennioInitialized = NO;

// Original IMP of `RCTHost instance:didInitializeRuntime:` saved on
// first swizzle so we can chain after running our re-bootstrap.
static IMP _ennioOriginalDidInitImp = NULL;
static SEL _ennioDidInitSel = NULL;

#ifdef ENNIO_HAVE_RCTINSTANCE
// Swizzled replacement: runs on the JS thread every time RCTInstance
// finishes wiring up a new jsi::Runtime. We refresh the JS-thread
// executor (instance pointer rotates on reload) and schedule the
// re-bootstrap via `callFunctionOnBufferedRuntimeExecutor` so the
// install happens AFTER the bundle finishes executing — installing on
// `globalThis` before Metro's bundle wrapper runs would get clobbered.
static void EnnioSwizzledDidInitializeRuntime(id self, SEL _cmd, id instance, facebook::jsi::Runtime& runtime) {
    @try {
        NSString* mark = [NSString stringWithFormat:@"%@/Library/_ennio_didinit_called.txt", NSHomeDirectory()];
        [@"called" writeToFile:mark atomically:YES encoding:NSUTF8StringEncoding error:nil];

        if ([instance isKindOfClass:[RCTInstance class]]) {
            __strong RCTInstance* strongInstance = (RCTInstance*)instance;
            // Update executor so background dispatchers route to the
            // new RCTInstance (old one was just invalidated on reload).
            margelo::nitro::ennio::HybridEnnio::JSThreadExecutor exec =
                [strongInstance](std::function<void(facebook::jsi::Runtime&)>&& fn) {
                    [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(fn)];
                };
            margelo::nitro::ennio::HybridEnnio::setJSThreadExecutor(std::move(exec));

            // Schedule re-install onto the JS thread, post-bundle.
            std::function<void(facebook::jsi::Runtime&)> reboot =
                [](facebook::jsi::Runtime& rt) {
                    margelo::nitro::ennio::HybridEnnio::nativeBootstrap(rt);
                    NSString* mark2 = [NSString stringWithFormat:@"%@/Library/_ennio_reload_rebootstrapped.txt", NSHomeDirectory()];
                    [@"ok" writeToFile:mark2 atomically:YES encoding:NSUTF8StringEncoding error:nil];
                    NSLog(@"[Ennio] Re-installed __ennioDispatch on reloaded JS context");
                };
            [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(reboot)];
        }
    } @catch (NSException* e) {
        NSLog(@"[Ennio] swizzled didInitializeRuntime raised: %@", e);
    }
    // Chain to original so RCTHost still forwards to its runtimeDelegate
    // (preserves app-provided init hooks).
    if (_ennioOriginalDidInitImp != NULL) {
        typedef void (*OrigFn)(id, SEL, id, facebook::jsi::Runtime&);
        ((OrigFn)_ennioOriginalDidInitImp)(self, _cmd, instance, runtime);
    }
}
#endif

// Distribution channel detection. Ennio is a dev / QA tool and must
// refuse to start on App Store production or Enterprise builds. The
// pod is already excluded from Release configurations at the
// CocoaPods level, so this is a runtime backstop in case a custom
// build setup links Ennio into a production binary anyway.
typedef NS_ENUM(NSInteger, EnnioDistribution) {
    EnnioDistDev,
    EnnioDistAdHoc,
    EnnioDistTestFlight,
    EnnioDistAppStore,
    EnnioDistEnterprise,
};

static EnnioDistribution ennioDetectDistribution(void) {
#if TARGET_OS_SIMULATOR
    // Simulator builds ship a placeholder StoreKit receipt named
    // "receipt" (same name App Store production builds use), which the
    // logic below would mis-classify as App Store and refuse to start.
    // The Simulator runs no production binary by definition, so short-
    // circuit to Dev before anything else.
    return EnnioDistDev;
#else
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

    // Xcode-attached debug builds on real hardware with no embedded
    // profile at all. Treat as Dev.
    return EnnioDistDev;
#endif
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
    // Diagnostic marker: when stdout/NSLog gets swallowed (idevicesyslog
    // sometimes drops app debug lines on device), the file proves +load ran.
    NSString* mark = [NSString stringWithFormat:@"%@/Library/_ennio_load_fired.txt", NSHomeDirectory()];
    [@"loaded" writeToFile:mark atomically:YES encoding:NSUTF8StringEncoding error:nil];

    // Start the Unix-domain control socket before any JS work runs.
    // Independent of Hermes Inspector — exists to bypass the JS-thread
    // queue for pure UIKit handlers (see EnnioControlSocket.cpp).
    ennio::EnnioControlSocket::start();

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

#ifdef ENNIO_HAVE_RCTINSTANCE
    // Also hook `instance:didInitializeRuntime:` — RCTInstance fires
    // this on EVERY runtime init (initial + every reload). Bypasses
    // the `host.runtimeDelegate` forwarder, which was silently
    // dropping our calls in some RN configurations.
    _ennioDidInitSel = NSSelectorFromString(@"instance:didInitializeRuntime:");
    Method didInitMethod = class_getInstanceMethod(hostClass, _ennioDidInitSel);
    if (didInitMethod) {
        _ennioOriginalDidInitImp = method_setImplementation(
            didInitMethod,
            (IMP)EnnioSwizzledDidInitializeRuntime
        );
        NSLog(@"[Ennio] RCTHost instance:didInitializeRuntime: swizzle installed");
    } else {
        NSLog(@"[Ennio] Could not find instance:didInitializeRuntime: on RCTHost");
    }
#endif
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

    // Distribution gate. Even if the CocoaPods `:configurations`
    // gate slipped and Ennio is linked into an App Store / Enterprise
    // binary, refuse to install `__ennioDispatch`, the commit hook,
    // or the ribbon. Runtime backstop on top of the build-time gate.
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
    // install the commit-signal walker + the `__ennioDispatch` JSI host
    // function. After this, the user's app never has to import `ennio`;
    // the package autolinks via Pod and bootstraps entirely from native,
    // and the CLI drives it over Hermes Inspector CDP.
    Ivar instanceIvar = class_getInstanceVariable([self class], "_instance");
    if (instanceIvar) {
        id rctInstance = object_getIvar(self, instanceIvar);
#ifdef ENNIO_HAVE_RCTINSTANCE
        if ([rctInstance isKindOfClass:[RCTInstance class]]) {
            __strong RCTInstance* strongInstance = (RCTInstance*)rctInstance;
            // Background dispatch workers need to schedule the
            // response-write back onto the JS thread (jsi::Runtime is
            // not thread-safe). RCTInstance.callFunctionOnBufferedRuntimeExecutor
            // is the only sanctioned scheduler that hands us a
            // Runtime& on the JS thread; wrap it as a std::function
            // and stash it via HybridEnnio for the worker thread to
            // pick up.
            margelo::nitro::ennio::HybridEnnio::JSThreadExecutor exec =
                [strongInstance](std::function<void(facebook::jsi::Runtime&)>&& fn) {
                    [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(fn)];
                };
            margelo::nitro::ennio::HybridEnnio::setJSThreadExecutor(std::move(exec));

            // Bootstrap (capture runtime, install commit signal +
            // `__ennioDispatch` JSI host function) once the JS thread
            // is ready. RCTInstance delivers our C++ lambda onto the
            // JS thread.
            std::function<void(facebook::jsi::Runtime&)> boot =
                [](facebook::jsi::Runtime& rt) {
                    NSString* m = [NSString stringWithFormat:@"%@/Library/_ennio_jsthread_fired.txt", NSHomeDirectory()];
                    [@"jsthread" writeToFile:m atomically:YES encoding:NSUTF8StringEncoding error:nil];
                    margelo::nitro::ennio::HybridEnnio::nativeBootstrap(rt);
                    NSString* m2 = [NSString stringWithFormat:@"%@/Library/_ennio_bootstrap_returned.txt", NSHomeDirectory()];
                    [@"returned" writeToFile:m2 atomically:YES encoding:NSUTF8StringEncoding error:nil];
                };
            [strongInstance callFunctionOnBufferedRuntimeExecutor:std::move(boot)];
            NSLog(@"[Ennio] Scheduled nativeBootstrap on JS thread");
            // Diagnostic marker: confirms ennio_start ran AND nativeBootstrap was scheduled.
            NSString* mark2 = [NSString stringWithFormat:@"%@/Library/_ennio_bootstrap_scheduled.txt", NSHomeDirectory()];
            [[NSString stringWithFormat:@"dist=%@", ennioDistributionName(dist)]
                writeToFile:mark2 atomically:YES encoding:NSUTF8StringEncoding error:nil];

            // Loud, greppable announce. If this line ever shows up in
            // Console.app on a non-dev device, the build pipeline has
            // leaked Ennio into a build it shouldn't be in.
            NSLog(@"[Ennio] __ennioDispatch host function installed (distribution: %@) — "
                  @"if you see this in production, your build pipeline is broken.",
                  ennioDistributionName(dist));

            // Show the top-right "E2E" ribbon — opt-in via the
            // `ENNIORibbonEnabled` Info.plist key (written by
            // `ennio-expo-plugin` when `showRibbon: true`). Default
            // off so devs iterating on UI don't get an always-on
            // overlay. Release builds don't compile this file at all
            // (CocoaPods :configurations gate), so the check is only
            // ever reached in Debug.
            id ribbonFlag = [[NSBundle mainBundle].infoDictionary objectForKey:@"ENNIORibbonEnabled"];
            BOOL showRibbon = [ribbonFlag isKindOfClass:[NSNumber class]] && [(NSNumber*)ribbonFlag boolValue];
            if (showRibbon) {
                [EnnioDebugBanner show];
            }
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
