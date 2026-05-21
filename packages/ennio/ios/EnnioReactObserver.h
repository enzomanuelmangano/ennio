//
// EnnioReactObserver.h
//
// Optional React Native commit observer. Hooks RN internals to receive
// a direct callback the moment a commit finishes, instead of polling
// the UIView hash on every CADisplayLink tick.
//
// Two strategies, tried in order at +start time:
//   1. NSNotificationCenter — observe `RCTUIManagerDidUpdateViewsNotification`
//      (Paper / legacy bridge). No swizzle, no private API.
//   2. Method swizzle on `RCTMountingManager` (Fabric / new arch). The
//      class is looked up by name at runtime — if the host app does not
//      embed Fabric, the swizzle is silently skipped.
//
// If neither strategy attaches, callers fall back to EnnioSettle's
// hash-change signal. attached() reports which (if any) is live.
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
/// classes are loaded — re-checks at every commit-sample call.
+ (void)start;

/// Current monotonic timestamp of the most recent RN commit observed,
/// in ms (mach_absolute_time domain, matches EnnioSettle::nowMs).
/// Returns 0 if no commit has been observed yet.
+ (uint64_t)lastCommitMs;

/// Block until lastCommitMs > sinceMs, or until maxMs elapses.
/// Returns the elapsed wait time in ms. If no observer strategy is
/// attached, returns immediately with 0 (caller should fall back).
+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs;

/// "paper" | "fabric" | "both" | "none" — diagnostic string for the
/// CLI to log on startup so users know which path is active.
+ (NSString *)attachmentDescription;

@end

NS_ASSUME_NONNULL_END
