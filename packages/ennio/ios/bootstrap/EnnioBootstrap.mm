//
// EnnioBootstrap.mm
//
// +load entry. Loads at dylib-attach time, before app code runs. Two jobs:
//
//   1. Start the Unix-domain socket listener so the CLI can connect as
//      soon as the simulator launches the app.
//   2. Register for UIApplicationDidFinishLaunchingNotification so we
//      can capture the key UIWindow + start settle observers once UIKit
//      is up.
//
// Distribution gate runs once in +load — if the build looks like a
// production / App Store / Enterprise binary, the dylib refuses to wire
// the socket listener. Runtime backstop on top of the CocoaPods
// :configurations build-time gate that already excludes ennio from
// Release builds.
//
// No JSI, no RN-version-specific linkage. The dylib doesn't know or
// care what the app is built with — only that it has a UIWindow and
// propagated accessibility identifiers.
//
// One swizzle IS installed (isolated, file-local IMP, guarded by
// dispatch_once):
//   - UIView -setAccessibilityIdentifier: (EnnioTestIDIndex) for the
//     O(1) testID index.
// It is observation-only — it does not alter app behavior.
//
// Settle / commit signals are provided entirely by EnnioSettle, a pure
// Apple-API engine (CFRunLoop + CADisplayLink frame-hash). There is no
// renderer-specific commit observer and no React linkage: the same
// signal serves Paper, Fabric, SwiftUI and UIKit.
//

#import "EnnioBootstrap.h"
#import "EnnioControlSocket.h"
#import "EnnioInitialURL.h"
#import "EnnioNoAnimations.h"
#import "EnnioSettle.h"
#import "EnnioShowTouches.h"
#import "EnnioTestIDIndex.h"

#import <objc/runtime.h>

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
    // "receipt" (same name as production builds use), which would
    // otherwise be misclassified as App Store. Sim is dev by definition.
    return EnnioDistDev;
#else
    NSURL *receiptURL = [NSBundle mainBundle].appStoreReceiptURL;
    NSString *receiptName = receiptURL.lastPathComponent;

    NSString *profilePath = [[NSBundle mainBundle] pathForResource:@"embedded"
                                                            ofType:@"mobileprovision"];
    NSData *profileData = profilePath ? [NSData dataWithContentsOfFile:profilePath] : nil;
    NSString *profileStr =
        profileData
            ? [[NSString alloc] initWithData:profileData encoding:NSISOLatin1StringEncoding]
            : nil;

    BOOL provisionsAllDevices = [profileStr containsString:@"<key>ProvisionsAllDevices</key>"];
    BOOL hasProvisionedDevices = [profileStr containsString:@"<key>ProvisionedDevices</key>"];
    BOOL hasProfile = (profileStr.length > 0);

    if (provisionsAllDevices) return EnnioDistEnterprise;
    if ([receiptName isEqualToString:@"receipt"]) return EnnioDistAppStore;
    if ([receiptName isEqualToString:@"sandboxReceipt"]) return EnnioDistTestFlight;
    if (hasProvisionedDevices) return EnnioDistAdHoc;
    if (hasProfile && !hasProvisionedDevices && !provisionsAllDevices) return EnnioDistAppStore;
    return EnnioDistDev;
#endif
}

static NSString *ennioDistributionName(EnnioDistribution d) {
    switch (d) {
        case EnnioDistDev: return @"Development";
        case EnnioDistAdHoc: return @"Ad-Hoc";
        case EnnioDistTestFlight: return @"TestFlight";
        case EnnioDistAppStore: return @"App Store";
        case EnnioDistEnterprise: return @"Enterprise";
    }
}

// =====================================================================
// Kill switches
// =====================================================================
//
// Per-hook env flags so a user hitting an injection crash (issue #44)
// can bisect which hook conflicts with their app — and keep testing
// with the rest. Set via `launchctl setenv` on the simulator (same
// channel as ENNIO_SOCKET_PATH; SIMCTL_CHILD_* drops non-DYLD names).
//
//   ENNIO_SAFE_MODE            — all of the below at once
//   ENNIO_DISABLE_TESTID_INDEX — no UIView setAccessibilityIdentifier:
//                                swizzle (finders fall back to walks)
//   ENNIO_DISABLE_SETTLE       — no CA commit ticker / runloop observer
//                                (the universal settle + commit signal)
//
// The socket listener itself has no flag: without it the CLI can't
// talk to the app at all, and it installs no hooks into app code.

static BOOL ennioFlag(const char *name) {
    const char *v = getenv(name);
    return v != NULL && v[0] != '\0' && strcmp(v, "0") != 0;
}

static BOOL ennioHookDisabled(const char *flag) {
    if (ennioFlag("ENNIO_SAFE_MODE")) return YES;
    if (ennioFlag(flag)) {
        return YES;
    }
    return NO;
}

static BOOL g_ennioReady = NO;
static __weak UIWindow *g_ennioKeyWindow = nil;

static UIWindow *_Nullable resolveKeyWindow(void) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            if (w.isKeyWindow) return w;
        }
    }
    // Fallback: first window from any active scene.
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        UIWindowScene *ws = (UIWindowScene *)scene;
        if (ws.windows.firstObject) return ws.windows.firstObject;
    }
    return nil;
}

@implementation EnnioBootstrap

+ (BOOL)isReady {
    return g_ennioReady;
}

+ (UIWindow *)keyWindow {
    UIWindow *strong = g_ennioKeyWindow;
    if (strong) return strong;
    strong = resolveKeyWindow();
    g_ennioKeyWindow = strong;
    return strong;
}

+ (void)load {
    // Host-process gate. DYLD_INSERT_LIBRARIES can attach the dylib to
    // any process that inherits the env var (launchctl, simctl helpers,
    // springboard children, etc.). Most of those aren't iOS apps and
    // our UIKit work would crash. Gate on the main bundle being an
    // iOS app bundle: CFBundlePackageType == "APPL" and the bundle
    // identifier looks like a real app (not a launchd label).
    //
    // We rely on NSClassFromString to load UIApplication, but in
    // non-iOS-app hosts UIApplication is linked but never
    // initialised. The bundle-type check is the reliable signal.
    NSDictionary *info = [NSBundle mainBundle].infoDictionary;
    NSString *pkgType = info[@"CFBundlePackageType"];
    if (![pkgType isEqualToString:@"APPL"]) {
        return;
    }
    // Also refuse if no bundle identifier is set (some test harnesses
    // load .app bundles without one).
    NSString *bundleId = [NSBundle mainBundle].bundleIdentifier;
    if (bundleId.length == 0) return;

    NSString *mark =
        [NSString stringWithFormat:@"%@/Library/_ennio_load_fired.txt", NSHomeDirectory()];
    [@"loaded" writeToFile:mark atomically:YES encoding:NSUTF8StringEncoding error:nil];

    EnnioDistribution dist = ennioDetectDistribution();
    if (dist == EnnioDistAppStore || dist == EnnioDistEnterprise) {
        NSLog(@"[Ennio] REFUSING to start: %@ distribution detected. "
              @"Ennio must never run in App Store or Enterprise builds. "
              @"Your build pipeline is leaking a remote-control surface — fix it.",
              ennioDistributionName(dist));
        return;
    }
    NSLog(@"[Ennio] Distribution: %@ — starting", ennioDistributionName(dist));

    // Install testID index swizzle BEFORE the socket listener / RN
    // bootstrap. Any UIView.accessibilityIdentifier assignment after
    // this call will land in the index — including RN's first commit
    // wave that runs on the JS thread shortly after this point.
    if (ennioHookDisabled("ENNIO_DISABLE_TESTID_INDEX")) {
        NSLog(@"[Ennio] testID index DISABLED via env flag");
    } else {
        [EnnioTestIDIndex start];
    }

    // Socket listener thread up immediately. Accepts will block until the
    // CLI connects — fine. Handlers will reject most ops with
    // "bootstrap:not-ready" until UIApplicationDidFinishLaunching fires.
    ennio::EnnioControlSocket::start();

    [[NSNotificationCenter defaultCenter] addObserver:[self class]
                                             selector:@selector(_ennioAppDidLaunch:)
                                                 name:UIApplicationDidFinishLaunchingNotification
                                               object:nil];
}

+ (void)_ennioAppDidLaunch:(NSNotification *)note {
    NSString *mark =
        [NSString stringWithFormat:@"%@/Library/_ennio_launched_fired.txt", NSHomeDirectory()];
    [@"launched" writeToFile:mark atomically:YES encoding:NSUTF8StringEncoding error:nil];

    // Resolve and cache the key window. App may not have one yet on this
    // notification (UIWindowScene activation is async); the next access
    // via +keyWindow re-resolves if cached value is nil.
    g_ennioKeyWindow = resolveKeyWindow();

    // Prime a cold deep link as react-navigation's initial URL (no-op unless
    // ENNIO_INITIAL_URL is set). Must run before the JS container mounts and
    // pulls getInitialURL — didFinishLaunching is well ahead of that.
    [EnnioInitialURL installIfEnabled];

    if (ennioHookDisabled("ENNIO_DISABLE_SETTLE")) {
        NSLog(@"[Ennio] settle observer DISABLED via env flag");
    } else {
        [EnnioSettle start];
    }

    // Opt-in animation suppressor (ENNIO_NO_ANIMATIONS) — collapses CA
    // transitions so the runner doesn't wait out 300-500ms slides/fades.
    [EnnioNoAnimations installIfEnabled];

    // Opt-in touch visualizer (ENNIO_SHOW_TOUCHES) — ripples on a
    // passthrough overlay, Android's "show touches" for the simulator.
    [EnnioShowTouches installIfEnabled];

    g_ennioReady = YES;
    NSLog(@"[Ennio] Bootstrap ready — socket dispatching commands (commit signal: "
          @"universal CoreAnimation/runloop, renderer-agnostic)");
}

@end
