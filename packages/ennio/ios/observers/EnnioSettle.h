//
// EnnioSettle.h
//
// THE universal settle / commit engine. Pure Apple APIs — CFRunLoop,
// CADisplayLink, UIView/CALayer, mach_time — and ZERO renderer internals.
// It is renderer-agnostic by construction: Paper, Fabric, SwiftUI, UIKit
// and Skia all commit through the same main runloop + CoreAnimation
// transaction, so a settle keyed on the runloop + the visible frame-hash
// fires for ALL of them with no per-renderer code, no reflection, and no
// version fragility. There is no separate "React commit" observer — the
// commit signal here IS the universal commit signal.
//
// Three mechanisms, all backed by the same two ground-truth signals
// (the beforeWaiting runloop observer + the per-vsync frame-hash ticker):
//
//   wait_idle  — CFRunLoopObserver for kCFRunLoopBeforeWaiting + main
//                thread quiet for the requested cooldown.
//   wait_commit — CADisplayLink samples visible UIView frames + alpha +
//                accessibilityLabel + accessibilityValue once per vsync,
//                computes a tiny hash, returns when the hash is stable
//                for a configured number of frames.
//   commit "since T" — wake on the runloop's beforeWaiting observer and
//                the per-vsync hash ticker, return the instant the visible
//                frame-hash last changed after a baseline timestamp. This
//                is the fast (~1 frame) post-tap confirm that used to be a
//                renderer-specific React hook; it is now universal.
//
// All timestamps are mach-time ms (monotonic, mach_absolute_time domain),
// shared across every signal here, so a caller can sample one before a
// tap and ask for the next commit strictly after it.
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

/// Returns the current visible-UIView hash sample (the same value the
/// CADisplayLink ticker observes). Callers use this to detect whether
/// a tap actually changed anything on screen by comparing pre/post
/// hashes; same value = visual no-op.
+ (uint64_t)currentHash;

/// Wait until the visible-UIView hash differs from `baselineHash` for
/// at least one CADisplayLink tick, or until `maxMs` elapses. Used as
/// a post-tap event-driven settle in place of a fixed sleep: returns
/// as soon as the screen reacts to a touch.
+ (uint32_t)waitForHashChangeSince:(uint64_t)baselineHash maxMs:(uint32_t)maxMs;

/// Monotonic timestamp (mach-time ms) of the most recent universal
/// commit — i.e. the last time the per-vsync frame-hash actually
/// changed. This is the renderer-agnostic replacement for the old RN
/// "lastCommitMs": Paper, Fabric, SwiftUI and UIKit all flush their
/// mutations through CoreAnimation, which the hash ticker samples once
/// per frame. Returns 0 before the first change (no commit seen yet).
+ (uint64_t)lastCommitMs;

/// Wait until a universal commit lands strictly after `sinceMs`
/// (i.e. the frame-hash changes after that mach-time-ms baseline), or
/// until `maxMs` elapses. Wakes on the per-vsync hash ticker and the
/// beforeWaiting runloop observer, so it confirms within ~1 frame
/// rather than polling. Renderer-agnostic; this is the fast post-tap
/// commit confirm. Returns the elapsed wait time in ms.
+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs;

/// Wait until no universal commit (no frame-hash change) has been seen
/// for `stableMs` consecutive ms, or until `maxMs` elapses. Renderer-
/// agnostic "the UI has gone quiet" signal. Returns YES if quiet was
/// reached, NO if the budget expired while commits were still landing.
+ (BOOL)waitForCommitQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs;

@end

NS_ASSUME_NONNULL_END
