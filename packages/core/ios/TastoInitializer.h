//
// EnnioInitializer.h
// Public Objective-C interface for initializing Ennio from Swift apps
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class RCTSurfacePresenter;

/**
 * EnnioInitializer - Call this from your AppDelegate to enable E2E testing
 *
 * This must be called after React Native is fully initialized and the
 * RCTSurfacePresenter is available.
 */
@interface EnnioInitializer : NSObject

/**
 * Initialize Ennio with the surface presenter from your React Native setup
 *
 * @param surfacePresenter The RCTSurfacePresenter from your app's React Native configuration
 */
+ (void)initializeWithSurfacePresenter:(RCTSurfacePresenter *)surfacePresenter;

/**
 * Check if Ennio has been properly initialized
 */
+ (BOOL)isInitialized;

@end

NS_ASSUME_NONNULL_END
