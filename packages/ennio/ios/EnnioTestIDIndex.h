//
// EnnioTestIDIndex.h
//
// O(1) testID → UIView index, maintained by swizzling
// -[UIView setAccessibilityIdentifier:]. RN propagates testID to
// accessibilityIdentifier on its host UIView under both Paper and
// Fabric, so the same swizzle catches both architectures.
//
// Backed by NSHashTable<UIView *> (weak refs) per testID. View
// dealloc removes its entry automatically.
//
// Concurrency: os_unfair_lock (not @synchronized) — the swizzle fires
// on every UIView identifier assignment across the entire app
// (typically several thousand per cold-start), and @synchronized's
// mutex overhead caused observable RN-thread contention in earlier
// experiments. os_unfair_lock is the right tool for short-held
// critical sections in hot paths.
//
// Find path:
//   1. lookup(testID) — instant hash check, returns first live + on-
//      screen view.
//   2. waitFor(testID, maxMs) — blocks on the React-commit broadcast
//      condition; re-checks after each wake. Returns immediately if
//      index already has a live entry.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioTestIDIndex : NSObject

/// Install the setAccessibilityIdentifier: swizzle. Idempotent.
/// Safe to call from EnnioBootstrap +load before UIKit-driven code
/// runs.
+ (void)start;

/// Latest-registered live view for testID, or nil.
+ (UIView *_Nullable)lookup:(NSString *)testID;

/// All live views matching testID, sorted by window-space Y/X.
+ (NSArray<UIView *> *)lookupAll:(NSString *)testID;

/// Block until lookup(testID) returns non-nil or maxMs elapses.
/// Wakes on each registration broadcast — no polling.
+ (UIView *_Nullable)waitFor:(NSString *)testID maxMs:(uint32_t)maxMs;

/// Current entry count — diagnostic only.
+ (NSUInteger)count;

/// Last attach status — diagnostic only.
+ (BOOL)isAttached;

@end

NS_ASSUME_NONNULL_END
