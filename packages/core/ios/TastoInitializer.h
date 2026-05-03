//
// TastoInitializer.h
// Public Objective-C interface for initializing Tasto from Swift apps
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class RCTSurfacePresenter;

/**
 * TastoInitializer - Call this from your AppDelegate to enable E2E testing
 *
 * This must be called after React Native is fully initialized and the
 * RCTSurfacePresenter is available.
 */
@interface TastoInitializer : NSObject

/**
 * Initialize Tasto with the surface presenter from your React Native setup
 *
 * @param surfacePresenter The RCTSurfacePresenter from your app's React Native configuration
 */
+ (void)initializeWithSurfacePresenter:(RCTSurfacePresenter *)surfacePresenter;

/**
 * Check if Tasto has been properly initialized
 */
+ (BOOL)isInitialized;

@end

NS_ASSUME_NONNULL_END
