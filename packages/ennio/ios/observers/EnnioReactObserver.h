//
// EnnioReactObserver.h
//
// Optional React Native commit observer. Receives a direct callback the
// moment a commit finishes, instead of polling the UIView hash on every
// CADisplayLink tick.
//
// Two crash-safe strategies, both signal-by-callback — no method
// swizzling, no interception of any C++-argument method, so neither can
// corrupt the host app:
//
//   1. Paper / legacy bridge — an NSNotificationCenter observer for
//      `RCTUIManagerDidUpdateViewsNotification`, keyed by name (no React
//      link). Posts once per UIView-mutation batch.
//   2. Fabric / new arch — our own object registered as an
//      RCTSurfacePresenterObserver; RN calls its
//      `didMountComponentsWithRootTag:` (NSInteger arg only) once per
//      mount. We declare the protocol locally and reach the live
//      RCTSurfacePresenter purely via the Obj-C runtime, every selector
//      respondsToSelector:-guarded; any nil/missing link bails to the
//      hash-polling fallback rather than crashing. This replaces the
//      removed `performTransaction:` swizzle (#44), which forwarded a
//      C++ const& arg through an objc IMP and crashed Skia / Expo
//      liquid-glass Fabric components on creation. There is NO swizzle
//      anywhere now.
//
// A source counts as live only AFTER it has actually fired at least once
// (registration alone always "succeeds"). On a Fabric app the paper
// notification never posts, so it never reports as a live signal there —
// the presenter observer is the Fabric commit signal. If neither source
// is live, callers fall back to EnnioSettle's hash-change signal.
// attachmentDescription() reports which sources are live.
//
// All timestamps are mach-time ms (monotonic), same domain as
// EnnioSettle, so the CLI can sample one before a tap and ask the
// observer to wait for the next commit strictly after that timestamp.
//

#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioReactObserver : NSObject

/// Install the observer hooks. Idempotent. Safe to call before RN
/// classes are loaded — the Fabric presenter attach retries on a bounded
/// backoff until the bridge/host comes up (or gives up to the fallback).
+ (void)start;

/// Current monotonic timestamp of the most recent RN commit observed,
/// in ms (mach_absolute_time domain, matches EnnioSettle::nowMs).
/// Returns 0 if no commit has been observed yet.
+ (uint64_t)lastCommitMs;

/// Block until lastCommitMs > sinceMs, or until maxMs elapses.
/// Returns the elapsed wait time in ms. If no observer strategy is
/// attached, returns immediately with 0 (caller should fall back).
+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs;

/// Wait until React has been quiet (no commits) for stableMs.
+ (BOOL)waitForReactQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs;

/// "paper" | "fabric" | "both" | "none" — diagnostic string for the CLI
/// to log on startup so users know which commit signal is live (or that
/// the caller is on the hash-polling fallback). Reports a source only
/// once it has actually fired, not on mere registration.
+ (NSString *)attachmentDescription;

@end

NS_ASSUME_NONNULL_END
