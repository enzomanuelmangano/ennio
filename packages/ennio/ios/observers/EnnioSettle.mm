//
// EnnioSettle.mm
//
// CFRunLoopObserver + CADisplayLink-driven settle signals.
//
// wait_idle: an NSCondition is signaled every time the main run loop
// enters BeforeWaiting. The waiter records the timestamp of the most
// recent signal and returns once enough time has passed since the last
// activity OR maxMs has elapsed.
//
// wait_commit: a CADisplayLink ticker samples a hash of every UIView
// in the key window that has an accessibilityIdentifier or non-empty
// accessibilityLabel. When the hash is unchanged for N consecutive
// frames the tree is considered settled.
//
// Both run on the main thread, signaling waiters via NSCondition so
// the socket handler threads can block without spinning.
//

#import "EnnioSettle.h"
#import "EnnioBootstrap.h"

#import <UIKit/UIKit.h>
#import <mach/mach_time.h>

#include <cstring>

static uint64_t nowMs(void) {
    static mach_timebase_info_data_t info = {0, 0};
    if (info.denom == 0) mach_timebase_info(&info);
    return (mach_absolute_time() * info.numer / info.denom) / 1000000ULL;
}

// =====================================================================
// wait_idle backing — runloop observer + last-activity timestamp.
// =====================================================================

static NSCondition *g_idleCondition;
static uint64_t g_lastActivityMs = 0;

static void idleObserverCallback(CFRunLoopObserverRef observer,
                                 CFRunLoopActivity activity,
                                 void *info) {
    [g_idleCondition lock];
    g_lastActivityMs = nowMs();
    [g_idleCondition broadcast];
    [g_idleCondition unlock];
}

// =====================================================================
// wait_commit backing — display link + frame hash.
// =====================================================================

static NSCondition *g_commitCondition;
static uint64_t g_lastHashChangeMs = 0;
static uint64_t g_currentHash = 0;
// Set true the first time the frame-hash actually changes (a real
// commit, not the seed value stamped at start). Until then lastCommitMs
// reports 0 — matching the "no commit observed yet" contract callers
// rely on when they use it as a strictly-after baseline.
static bool g_commitSeen = false;

// Hash helper — FNV-1a 64-bit over a sequence of bytes.
static inline void hashFeed(uint64_t *h, const void *data, size_t len) {
    const unsigned char *p = (const unsigned char *)data;
    for (size_t i = 0; i < len; i++) {
        *h ^= p[i];
        *h *= 1099511628211ULL;
    }
}

static void walkAndHash(UIView *v, uint64_t *h) {
    if (!v) return;
    if (v.hidden || v.alpha < 0.01) {
        // Hidden subtree — feed a sentinel and stop descending.
        const char *s = "HIDE";
        hashFeed(h, s, 4);
        return;
    }
    CGRect window = [v.window convertRect:v.bounds fromView:v];
    int32_t x = (int32_t)window.origin.x;
    int32_t y = (int32_t)window.origin.y;
    int32_t w = (int32_t)window.size.width;
    int32_t hgt = (int32_t)window.size.height;
    hashFeed(h, &x, sizeof(x));
    hashFeed(h, &y, sizeof(y));
    hashFeed(h, &w, sizeof(w));
    hashFeed(h, &hgt, sizeof(hgt));
    // EXPERIMENT: alpha excluded from the settle hash. A Reanimated /
    // per-frame opacity animation mutates the MODEL alpha every frame,
    // churning the hash so wait_commit never reaches `stableMs` until the
    // fade ends — burning the whole animation per tap. Opacity doesn't
    // affect hittability (a 50%-opacity control is fully tappable), so
    // dropping it lets settle return once the structural tree is stable.

    NSString *aid = v.accessibilityIdentifier;
    if (aid.length) {
        const char *s = aid.UTF8String;
        hashFeed(h, s, std::strlen(s));
    }
    NSString *lab = v.accessibilityLabel;
    if (lab.length) {
        const char *s = lab.UTF8String;
        hashFeed(h, s, std::strlen(s));
    }
    NSString *val = v.accessibilityValue;
    if (val.length) {
        const char *s = val.UTF8String;
        hashFeed(h, s, std::strlen(s));
    }
    for (UIView *sub in v.subviews) walkAndHash(sub, h);
}

@interface EnnioCommitTicker : NSObject
@property(nonatomic, strong) CADisplayLink *link;
- (void)tick:(CADisplayLink *)link;
@end

@implementation EnnioCommitTicker

- (void)tick:(CADisplayLink *)link {
    UIWindow *win = [EnnioBootstrap keyWindow];
    if (!win) return;
    uint64_t h = 1469598103934665603ULL; // FNV offset basis
    walkAndHash(win, &h);

    [g_commitCondition lock];
    if (h != g_currentHash) {
        g_currentHash = h;
        g_lastHashChangeMs = nowMs();
        g_commitSeen = true;
        [g_commitCondition broadcast];
    }
    [g_commitCondition unlock];
}

@end

static EnnioCommitTicker *g_commitTicker;

// =====================================================================
// EnnioSettle implementation
// =====================================================================

@implementation EnnioSettle

+ (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_idleCondition = [NSCondition new];
        g_commitCondition = [NSCondition new];
        g_lastActivityMs = nowMs();
        g_lastHashChangeMs = nowMs();

        // RunLoop observer for kCFRunLoopBeforeWaiting.
        CFRunLoopObserverRef observer = CFRunLoopObserverCreate(
            kCFAllocatorDefault, kCFRunLoopBeforeWaiting, true, 0, idleObserverCallback, NULL);
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
        CFRelease(observer);

        // CADisplayLink ticker for wait_commit hashing.
        g_commitTicker = [EnnioCommitTicker new];
        g_commitTicker.link =
            [CADisplayLink displayLinkWithTarget:g_commitTicker selector:@selector(tick:)];
        [g_commitTicker.link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    });
}

+ (uint32_t)waitForIdleWithTimeout:(uint32_t)maxMs {
    // Never started (ENNIO_DISABLE_SETTLE / safe mode): return
    // immediately — [nil waitUntilDate:] is a no-op, so the loops
    // below would busy-spin until maxMs.
    if (!g_idleCondition) return 0;
    static const uint32_t kIdleCooldownMs = 50;
    uint64_t start = nowMs();
    [g_idleCondition lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceStart = now - start;
        if (sinceStart >= maxMs) {
            [g_idleCondition unlock];
            return maxMs;
        }
        uint64_t sinceActivity = now - g_lastActivityMs;
        if (sinceActivity >= kIdleCooldownMs) {
            [g_idleCondition unlock];
            return (uint32_t)sinceStart;
        }
        uint64_t waitMs = kIdleCooldownMs - sinceActivity;
        uint64_t remaining = maxMs - sinceStart;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_idleCondition waitUntilDate:deadline];
    }
}

+ (uint32_t)waitForCommitWithTimeout:(uint32_t)maxMs stableForMs:(uint32_t)stableMs {
    if (!g_commitCondition) return 0; // settle disabled — no signal source
    uint64_t start = nowMs();
    [g_commitCondition lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceStart = now - start;
        if (sinceStart >= maxMs) {
            [g_commitCondition unlock];
            return maxMs;
        }
        uint64_t sinceChange = now - g_lastHashChangeMs;
        if (sinceChange >= stableMs) {
            [g_commitCondition unlock];
            return (uint32_t)sinceStart;
        }
        uint64_t waitMs = stableMs - sinceChange;
        uint64_t remaining = maxMs - sinceStart;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_commitCondition waitUntilDate:deadline];
    }
}

+ (uint64_t)currentHash {
    return g_currentHash;
}

+ (uint32_t)waitForHashChangeSince:(uint64_t)baselineHash maxMs:(uint32_t)maxMs {
    if (!g_commitCondition) return 0; // settle disabled — no signal source
    NSDate *start = [NSDate date];
    if (g_currentHash != baselineHash) return 0;
    [g_commitCondition lock];
    while (g_currentHash == baselineHash) {
        uint32_t elapsed = (uint32_t)([[NSDate date] timeIntervalSinceDate:start] * 1000);
        if (elapsed >= maxMs) break;
        uint32_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_commitCondition waitUntilDate:deadline];
    }
    [g_commitCondition unlock];
    return (uint32_t)([[NSDate date] timeIntervalSinceDate:start] * 1000);
}

+ (uint64_t)lastCommitMs {
    // 0 until a real commit has been observed — the seed timestamp
    // stamped at +start does not count as a commit.
    return g_commitSeen ? g_lastHashChangeMs : 0;
}

+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs {
    if (!g_commitCondition) return 0; // settle disabled — no signal source
    // The hash ticker broadcasts g_commitCondition the instant the
    // visible frame-hash changes (once per vsync), so this wakes within
    // ~1 frame of the next commit rather than polling. Renderer-agnostic:
    // the change reflects whatever committed through CoreAnimation
    // (Paper / Fabric / SwiftUI / UIKit).
    uint64_t start = nowMs();
    [g_commitCondition lock];
    while (g_lastHashChangeMs <= sinceMs) {
        uint64_t now = nowMs();
        uint64_t elapsed = now - start;
        if (elapsed >= maxMs) break;
        uint64_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_commitCondition waitUntilDate:deadline];
    }
    [g_commitCondition unlock];
    return (uint32_t)(nowMs() - start);
}

+ (BOOL)waitForCommitQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs {
    // No signal source (settle disabled) → report quiet so the caller
    // proceeds; it falls back to other gates elsewhere.
    if (!g_commitCondition) return YES;
    uint64_t start = nowMs();
    [g_commitCondition lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceChange = now - g_lastHashChangeMs;
        if (sinceChange >= stableMs) {
            [g_commitCondition unlock];
            return YES;
        }
        uint64_t totalElapsed = now - start;
        if (totalElapsed >= maxMs) {
            [g_commitCondition unlock];
            return NO;
        }
        uint64_t waitMs = stableMs - sinceChange;
        uint64_t remaining = maxMs - totalElapsed;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_commitCondition waitUntilDate:deadline];
    }
}

@end
