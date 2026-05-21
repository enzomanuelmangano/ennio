//
// EnnioFinderFabric.h
//
// Fabric (RN new-arch) finder. Unlike Paper, Fabric stores testID
// directly on the C++ ShadowNode (`ViewProps::testId`), so the
// shadow tree IS the right place to look up testIDs before
// UIView mount. Real win for apps on new-arch: pre-mount
// visibility + O(N) over a small (< 200 node) tree.
//
// STUB today. Full impl needs:
//   1. RCTSurfacePresenter._scheduler (objc, exists)
//   2. _scheduler.getMountingTransactionsForRootTag (C++)
//   3. Walk facebook::react::ShadowNode tree
//   4. Read ConcreteViewShadowNode->getConcreteProps().testId
//   5. Map ShadowNode.tag → UIView via RCTComponentViewRegistry
//
// Requires linking against React-RCTFabric headers (and per-RN-
// version updates because Fabric internals churn quarterly). Hence
// stub — we ship the seam, wire it in when we commit to per-version
// build matrix.
//
// Until then: testID-index swizzle (arch-agnostic) + UIView walk
// fallback handle Fabric apps as-is, since RN propagates testID to
// UIView.accessibilityIdentifier in BOTH archs during mount.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioFinderFabric : NSObject

/// YES when Fabric is the active arch (RCTSurfacePresenter +
/// RCTScheduler are loaded). Diagnostic only — stub impl always
/// returns nil for lookups today.
+ (BOOL)isAvailable;

+ (UIView *_Nullable)findByTestID:(NSString *)testID;
+ (UIView *_Nullable)findByText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
