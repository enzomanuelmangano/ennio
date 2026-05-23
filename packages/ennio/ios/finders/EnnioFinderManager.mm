//
// EnnioFinderManager.mm — see header.
//

#import "EnnioFinderManager.h"

#import "EnnioFinderUIView.h"
#import "EnnioTestIDIndex.h"
#import "EnnioFinder.h"

@implementation EnnioFinderManager

+ (UIView *)findByTestID:(NSString *)testID {
    if (!testID.length) return nil;
    // 1. O(1) index — swizzle-maintained on UIView.
    //    setAccessibilityIdentifier:, fires the same vsync RN sets the
    //    identifier during mount. Arch-agnostic — Paper + Fabric both
    //    propagate testID through this setter.
    UIView *v = [EnnioTestIDIndex lookup:testID];
    if (v && [EnnioFinder isOnScreen:v]) return v;
    // 2. UIView walk — fallback for host code that bypassed the
    //    swizzled setter (KVC ivar writes, runtime class swap, etc.)
    //    or that assigned the identifier before our dylib loaded.
    v = [EnnioFinderUIView findByTestID:testID];
    if (v && [EnnioFinder isOnScreen:v]) return v;
    return nil;
}

+ (UIView *)waitForTestID:(NSString *)testID maxMs:(uint32_t)maxMs {
    // Fast path: index already has a live entry.
    UIView *v = [self findByTestID:testID];
    if (v) return v;
    // Event-driven wait — block on the testID-index broadcast.
    // Returns as soon as the swizzle catches a matching identifier
    // assignment.
    v = [EnnioTestIDIndex waitFor:testID maxMs:maxMs];
    if (v && [EnnioFinder isOnScreen:v]) return v;
    // Last resort: short poll loop in case the view was registered
    // outside the swizzle's reach (KVC ivar write, runtime swap).
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
    while ([deadline timeIntervalSinceNow] > 0) {
        v = [self findByTestID:testID];
        if (v) return v;
        [NSThread sleepForTimeInterval:0.016];
    }
    return nil;
}

+ (UIView *)findByText:(NSString *)text {
    if (!text.length) return nil;
    UIView *v = [EnnioFinderUIView findByText:text];
    if (v && [EnnioFinder isOnScreen:v]) return v;
    return nil;
}

+ (NSString *)attachmentDescription {
    NSMutableArray<NSString *> *parts = [NSMutableArray new];
    if ([EnnioTestIDIndex isAttached]) [parts addObject:@"index"];
    [parts addObject:@"uiview"];
    return [parts componentsJoinedByString:@","];
}

@end
