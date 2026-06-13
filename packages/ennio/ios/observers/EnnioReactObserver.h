//
// EnnioReactObserver.h
//
// Optional React Native commit observer. Hooks RN's commit notification
// to receive a direct callback the moment a commit finishes, instead of
// polling the UIView hash on every CADisplayLink tick.
//
// Single strategy: NSNotificationCenter — observe
// `RCTUIManagerDidUpdateViewsNotification` (Paper / legacy bridge). No
// swizzle, no private API, nothing to corrupt.
//
// A second strategy used to swizzle a Fabric mount method
// (`RCTMountingManager performTransaction:` et al.) for a commit signal
// on the New Architecture. It was removed: forwarding Fabric's
// C++-argument mount methods through an objc IMP crashed third-party
// Fabric components (Skia, Expo liquid-glass) and SIGSEGV'd on RN 0.85
// (#44). On Fabric apps the notification simply doesn't fire and callers
// fall back to EnnioSettle's hash-change signal — which settles fine.
//
// If the observer doesn't attach, callers fall back to EnnioSettle's
// hash-change signal. attached() reports whether it's live.
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

/// Wait until React has been quiet (no commits) for stableMs.
+ (BOOL)waitForReactQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs;

/// "paper" | "none" — diagnostic string for the CLI to log on startup
/// so users know whether the commit observer is live or the caller is on
/// the hash-polling fallback.
+ (NSString *)attachmentDescription;

@end

NS_ASSUME_NONNULL_END
