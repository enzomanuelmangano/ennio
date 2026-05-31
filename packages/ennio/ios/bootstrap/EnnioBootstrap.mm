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
// Two swizzles ARE installed (both isolated, file-local IMPs, guarded
// by dispatch_once):
//   - UIView -setAccessibilityIdentifier: (EnnioTestIDIndex) for the
//     O(1) testID index.
//   - the RN mount/commit method (EnnioReactObserver) for settle
//     signals. Paper uses an NSNotification; Fabric is swizzled.
// They are observation-only — neither alters app behavior.
//

#import "EnnioBootstrap.h"
#import "EnnioControlSocket.h"
#import "EnnioReactObserver.h"
#import "EnnioSettle.h"
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
    [EnnioTestIDIndex start];

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

    [EnnioSettle start];
    [EnnioReactObserver start];

    g_ennioReady = YES;
    NSLog(@"[Ennio] Bootstrap ready — socket dispatching commands (RN observer: %@)",
          [EnnioReactObserver attachmentDescription]);
}

@end
