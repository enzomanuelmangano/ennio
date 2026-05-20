//
// EnnioSettle.h
//
// UIKit-based settle / sync. No React commit hook, no JSI. Two mechanisms:
//
//   wait_idle  — CFRunLoopObserver for kCFRunLoopBeforeWaiting + main
//                thread quiet for the requested cooldown.
//   wait_commit — CADisplayLink samples visible UIView frames + alpha +
//                accessibilityLabel + accessibilityValue once per vsync,
//                computes a tiny hash, returns when the hash is stable
//                for a configured number of frames.
//
// Both are pure Apple APIs. The settle latencies (~50ms idle, ~100ms
// commit) are slower than an RN commit hook (~5ms), but the engine has
// zero React internals to maintain.
//

#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioSettle : NSObject

/// Start the runloop observer + display link. Called once from
/// UIApplicationDidFinishLaunchingNotification. Idempotent.
+ (void)start;

/// Block the caller until the run loop has hit kCFRunLoopBeforeWaiting
/// with no main-thread work for ~50ms, or until maxMs elapses.
/// Returns the elapsed time in ms (capped at maxMs).
+ (uint32_t)waitForIdleWithTimeout:(uint32_t)maxMs;

/// Block the caller until the visible-UIView hash has been stable for
/// `stableMs` consecutive ms, or until maxMs elapses. Returns the
/// elapsed time in ms.
+ (uint32_t)waitForCommitWithTimeout:(uint32_t)maxMs stableForMs:(uint32_t)stableMs;

@end

NS_ASSUME_NONNULL_END
