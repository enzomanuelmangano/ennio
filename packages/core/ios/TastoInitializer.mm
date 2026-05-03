//
// TastoInitializer.mm
// Objective-C++ implementation for Tasto initialization
//

#import "TastoInitializer.h"
#import "TastoRuntimeHelper.h"
#import <React/RCTSurfacePresenter.h>

@implementation TastoInitializer

+ (void)initializeWithSurfacePresenter:(RCTSurfacePresenter *)surfacePresenter {
    if (surfacePresenter == nil) {
        NSLog(@"[Tasto] Warning: surfacePresenter is nil, cannot initialize");
        return;
    }

    TastoSetSurfacePresenter(surfacePresenter);
    NSLog(@"[Tasto] Initialized with surface presenter");
}

+ (BOOL)isInitialized {
    return tasto::TastoRuntimeHelper::getInstance().isInitialized();
}

@end
