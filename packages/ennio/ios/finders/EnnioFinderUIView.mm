//
// EnnioFinderUIView.mm — see header.
//

#import "EnnioFinderUIView.h"
#import "EnnioFinder.h"

@implementation EnnioFinderUIView

+ (UIView *)findByTestID:(NSString *)testID {
    return [EnnioFinder findViewByTestID:testID];
}

+ (UIView *)findByText:(NSString *)text {
    return [EnnioFinder findViewByText:text];
}

@end
