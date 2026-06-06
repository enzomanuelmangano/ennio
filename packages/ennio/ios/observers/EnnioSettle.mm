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
    uint8_t alphaQ = (uint8_t)(v.alpha * 255);
    hashFeed(h, &x, sizeof(x));
    hashFeed(h, &y, sizeof(y));
    hashFeed(h, &w, sizeof(w));
    hashFeed(h, &hgt, sizeof(hgt));
    hashFeed(h, &alphaQ, sizeof(alphaQ));

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

@end
