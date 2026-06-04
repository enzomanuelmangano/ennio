//
// EnnioHIDInjector.h
//
// In-process real-HID injection. Replaces idb_companion's host-side
// CoreSimulator Indigo path with the same touch pipeline entered one
// layer up — inside the app process, at UIApplication's HID ingestion
// point (`_enqueueHIDEvent:`).
//
// Why this is real, not synthesis: the event is a genuine IOHIDEvent
// digitizer event. UIApplication's `_collectHIDEventsRunLoopSource`
// dequeues it and runs the FULL pipeline — UITouch construction,
// hit-testing, UIGestureRecognizer arbitration, the responder chain.
// RNGH, Pressable, RCTScrollView momentum, RN's responder system all
// see a real finger. This is the path CoreSim delivers idb's events
// into; we enter it directly, so no host daemon, no private host
// framework, no Indigo struct to track across Xcode versions.
//
// Coordinates are normalized [0,1] fractions of the key window
// (origin top-left) — UIKit maps them to screen points.
//

#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioHIDInjector : NSObject

/// Touch DOWN at normalized (x,y). Begins a touch sequence.
+ (BOOL)touchDownAtX:(double)x y:(double)y;

/// Touch MOVE to normalized (x,y). Must follow a down.
+ (BOOL)touchMoveToX:(double)x y:(double)y;

/// Touch UP at normalized (x,y). Ends the sequence.
+ (BOOL)touchUpAtX:(double)x y:(double)y;

@end

NS_ASSUME_NONNULL_END
