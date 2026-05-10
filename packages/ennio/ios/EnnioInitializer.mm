//
// EnnioInitializer.mm
// Objective-C++ implementation for Ennio initialization
//

#import "EnnioInitializer.h"
#import "EnnioRuntimeHelper.h"
#import <React/RCTSurfacePresenter.h>

@implementation EnnioInitializer

+ (void)initializeWithSurfacePresenter:(RCTSurfacePresenter *)surfacePresenter {
    if (surfacePresenter == nil) {
        NSLog(@"[Ennio] Warning: surfacePresenter is nil, cannot initialize");
        return;
    }

    EnnioSetSurfacePresenter(surfacePresenter);
    NSLog(@"[Ennio] Initialized with surface presenter");
}

+ (BOOL)isInitialized {
    return ennio::EnnioRuntimeHelper::getInstance().isInitialized();
}

@end
