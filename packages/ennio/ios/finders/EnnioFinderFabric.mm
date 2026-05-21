//
// EnnioFinderFabric.mm — see header. Stub impl, holds the seam.
//

#import "EnnioFinderFabric.h"

#import <objc/runtime.h>

static int g_available = -1;

static BOOL probe(void) {
    if (g_available != -1) return g_available == 1;
    Class presenterCls = NSClassFromString(@"RCTSurfacePresenter");
    Class schedCls = NSClassFromString(@"RCTScheduler");
    g_available = (presenterCls && schedCls) ? 1 : 0;
    return g_available == 1;
}

@implementation EnnioFinderFabric

+ (BOOL)isAvailable {
    return probe();
}

+ (UIView *)findByTestID:(NSString *)testID {
    (void)testID;
    return nil;
}

+ (UIView *)findByText:(NSString *)text {
    (void)text;
    return nil;
}

@end
