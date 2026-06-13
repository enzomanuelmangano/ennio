//
// EnnioReactObserver.mm — see header for strategy.
//

#import "EnnioReactObserver.h"

#import <UIKit/UIKit.h>
#import <mach/mach_time.h>

static NSCondition *g_cond;
static uint64_t g_lastCommitMs = 0;
static bool g_paperAttached = false;

static uint64_t nowMs(void) {
    static mach_timebase_info_data_t info = {0, 0};
    if (info.denom == 0) mach_timebase_info(&info);
    return (mach_absolute_time() * info.numer / info.denom) / 1000000ULL;
}

static void markCommit(void) {
    [g_cond lock];
    g_lastCommitMs = nowMs();
    [g_cond broadcast];
    [g_cond unlock];
}

// =====================================================================
// Paper: RCTUIManagerDidUpdateViewsNotification
// =====================================================================
//
// This is the ONLY commit signal Ennio attaches. It's a plain
// NSNotificationCenter observer keyed by name — no method swizzling, no
// linking against React — so it can never corrupt the host app.
//
// We used to ALSO swizzle a Fabric mount method (performTransaction: et
// al.) to get a commit signal on the New Architecture. That swizzle was
// removed: forwarding Fabric's C++-argument mount methods through an
// objc IMP is undefined behaviour, and it crashed third-party Fabric
// components on creation — Skia's <Canvas>, Expo's native liquid-glass
// (ExpoFabricView.injectInitializer assertion), and it SIGSEGV'd on RN
// 0.85 (issue #44). The risk was never worth it: when no commit signal
// is observed, waitForCommitSince returns 0 and the CLI falls back to
// CADisplayLink frame-hash polling, which settles fine on Fabric. A
// slightly slower settle beats a corrupted host app.

static bool attachPaperObserver(void) {
    // Notification name is a string constant in RN; we observe by name
    // so we don't link against React.
    NSString *name = @"RCTUIManagerDidUpdateViewsNotification";
    [[NSNotificationCenter defaultCenter] addObserverForName:name
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification * _Nonnull note) {
        (void)note;
        markCommit();
    }];
    return true;
}

// =====================================================================
// EnnioReactObserver
// =====================================================================

@implementation EnnioReactObserver

+ (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_cond = [NSCondition new];
        // RN may not be fully loaded yet at dylib-init time. Defer attach
        // to didFinishLaunching.
        dispatch_async(dispatch_get_main_queue(), ^{
            g_paperAttached = attachPaperObserver();
        });
    });
}

+ (uint64_t)lastCommitMs {
    return g_lastCommitMs;
}

/// Wait until React has been quiet for stableMs (no commits observed
/// for that long), or until maxMs elapses. Returns 1 if quiet was
/// reached, 0 if the timeout fired while commits were still arriving.
+ (BOOL)waitForReactQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs {
    if (!g_paperAttached) return YES;
    uint64_t start = nowMs();
    [g_cond lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceCommit = now - g_lastCommitMs;
        if (sinceCommit >= stableMs) {
            [g_cond unlock];
            return YES;
        }
        uint64_t totalElapsed = now - start;
        if (totalElapsed >= maxMs) {
            [g_cond unlock];
            return NO;
        }
        uint64_t waitMs = stableMs - sinceCommit;
        uint64_t remaining = maxMs - totalElapsed;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
}

+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs {
    // No observer attached → bail; caller falls back to hash polling.
    if (!g_paperAttached) return 0;

    uint64_t start = nowMs();
    [g_cond lock];
    while (g_lastCommitMs <= sinceMs) {
        uint64_t now = nowMs();
        uint64_t elapsed = now - start;
        if (elapsed >= maxMs) break;
        uint64_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
    [g_cond unlock];
    return (uint32_t)(nowMs() - start);
}

+ (NSString *)attachmentDescription {
    return g_paperAttached ? @"paper" : @"none";
}

@end
