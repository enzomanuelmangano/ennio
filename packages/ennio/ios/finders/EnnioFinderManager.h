//
// EnnioFinderManager.h
//
// Coordinates ennio's finder strategies. Single entry point for
// every "find a view" request from the socket handlers:
//
//   1. EnnioTestIDIndex   — O(1) hash lookup, populated by swizzling
//                           UIView.setAccessibilityIdentifier
//                           (arch-agnostic; catches every RN view).
//   2. EnnioFinderUIView  — last-resort UIWindow + presented-VC walk.
//
// The manager also implements the event-driven waiting:
// `waitForTestID:maxMs:` blocks on the testID-index NSCondition,
// so callers don't poll. Falls through to a brief UIView walk poll
// when the index broadcast never lands (host code that bypasses the
// swizzled setter).
//
// Each strategy is independently testable and swappable. Adding a
// fourth finder (e.g. accessibility-daemon scrape) is a matter of
// implementing the same {findByTestID:, findByText:} pair and
// inserting it into the chain at the desired priority.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioFinderManager : NSObject

/// Synchronous find. Walks the strategy chain in priority order.
/// Returns the first non-nil + on-screen UIView, or nil.
+ (UIView *_Nullable)findByTestID:(NSString *)testID;

/// Event-driven find. Blocks on the testID-index broadcast until a
/// matching live view exists, or until maxMs elapses. Returns nil
/// on timeout. No polling — wakes on each setAccessibilityIdentifier
/// registration the swizzle catches.
+ (UIView *_Nullable)waitForTestID:(NSString *)testID maxMs:(uint32_t)maxMs;

/// Text-selector find. Same chain.
+ (UIView *_Nullable)findByText:(NSString *)text;

/// Diagnostic: comma-separated list of strategies that probed YES
/// (e.g. "index,paper,uiview"). Used in startup log.
+ (NSString *)attachmentDescription;

@end

NS_ASSUME_NONNULL_END
