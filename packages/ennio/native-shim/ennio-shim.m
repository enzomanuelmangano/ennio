// ennio shim: safe to DYLD_INSERT_LIBRARIES into any process on the simulator.
//
// The CLI sets this shim as the simulator's global DYLD_INSERT_LIBRARIES so
// every process spawned on the sim (including SpringBoard-launched apps that
// don't inherit per-process env vars) loads it. The shim's job is to *gate*:
// only continue into the real per-RN-version ennio dylib when:
//
//   1. The host is a React Native process (RCTInstance class is present).
//      Catches Safari, Calculator, system daemons, etc.
//   2. The host's bundle id matches `ENNIO_TARGET_BUNDLE_ID`, the env var
//      the CLI sets per session. Without this, a stale launchctl env after
//      a CLI crash would inject ennio into the next innocent RN app the
//      developer happens to launch on the same simulator.
//   3. The host has no App Store receipt — i.e. it's a simulator/dev build.
//      Real-device App Store / TestFlight / Enterprise binaries always
//      ship with a receipt; we refuse to load there as a safety net.
//
// If any guard fails, the shim returns silently. The real dylib is never
// dlopened; the host process is unaffected.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <dlfcn.h>

__attribute__((constructor))
static void ennio_shim_init(void) {
    @autoreleasepool {
        Class rctInstance = objc_getClass("RCTInstance");
        if (!rctInstance) {
            return;
        }

        NSDictionary *env = [[NSProcessInfo processInfo] environment];

        NSString *targetBundleId = env[@"ENNIO_TARGET_BUNDLE_ID"];
        if (targetBundleId.length > 0) {
            NSString *ourBundleId = [[NSBundle mainBundle] bundleIdentifier];
            if (![ourBundleId isEqualToString:targetBundleId]) {
                return;
            }
        }

        NSString *receiptPath = [[[NSBundle mainBundle] appStoreReceiptURL] path];
        if (receiptPath && [[NSFileManager defaultManager] fileExistsAtPath:receiptPath]) {
            return;
        }

        NSString *realPath = env[@"ENNIO_DYLIB_PATH"];
        if (!realPath) {
            return;
        }
        void *handle = dlopen([realPath UTF8String], RTLD_NOW | RTLD_GLOBAL);
        if (!handle) {
            NSLog(@"[Ennio shim] dlopen(%@) failed: %s", realPath, dlerror());
            return;
        }
        NSLog(@"[Ennio shim] loaded real ennio from %@", realPath);
    }
}
