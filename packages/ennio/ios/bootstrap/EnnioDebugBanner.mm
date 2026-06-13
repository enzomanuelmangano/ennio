//
// EnnioDebugBanner.mm
//

#import "EnnioDebugBanner.h"
#import <UIKit/UIKit.h>

// ─────────────────────────────────────────────────────────────────────
// Pass-through window: hit-test always nil, so taps never land on the
// banner — they fall through to whatever app view is below. Same trick
// Flutter uses for its DEBUG ribbon.
// ─────────────────────────────────────────────────────────────────────

@interface EnnioPassthroughWindow : UIWindow
@end

@implementation EnnioPassthroughWindow
- (UIView*)hitTest:(CGPoint)point withEvent:(UIEvent*)event { return nil; }
@end

// ─────────────────────────────────────────────────────────────────────
// Ribbon view: 150x150 container anchored top-right. A red UIView
// "stripe" subview sits diagonally across the corner via a +45°
// rotation transform — same orientation as Flutter's debug banner.
// A bold white UILabel inside the stripe reads naturally along the
// diagonal. No custom drawRect → CALayer handles all the geometry,
// shadow, and text rasterisation cleanly.
// ─────────────────────────────────────────────────────────────────────

static CGFloat const kEnnioBannerSize        = 130.0;
static CGFloat const kEnnioStripeWidth       = 160.0; // longer than diagonal
static CGFloat const kEnnioStripeHeight      = 18.0;
static CGFloat const kEnnioStripeFromCorner  = 42.0;  // px from corner (along diagonal)

@interface EnnioRibbonView : UIView
@end

@implementation EnnioRibbonView

- (instancetype)init {
    self = [super initWithFrame:CGRectMake(0, 0, kEnnioBannerSize, kEnnioBannerSize)];
    if (self) {
        self.backgroundColor = [UIColor clearColor];
        self.userInteractionEnabled = NO;
        self.clipsToBounds = NO;

        // Stripe — solid red, with a soft shadow so it stays visible
        // on any background.
        UIView* stripe = [[UIView alloc] initWithFrame:
            CGRectMake(0, 0, kEnnioStripeWidth, kEnnioStripeHeight)];
        stripe.backgroundColor = [UIColor systemRedColor];
        stripe.layer.shadowColor   = [UIColor blackColor].CGColor;
        stripe.layer.shadowOpacity = 0.30;
        stripe.layer.shadowOffset  = CGSizeMake(0, 1);
        stripe.layer.shadowRadius  = 2.5;
        stripe.userInteractionEnabled = NO;

        // Label — bold white "E2E", filling the stripe bounds, drawn
        // in unrotated coordinates so the rotation transform applies
        // to label + background as one unit.
        UILabel* label = [[UILabel alloc] initWithFrame:stripe.bounds];
        label.text = @"E2E";
        label.font = [UIFont systemFontOfSize:10 weight:UIFontWeightHeavy];
        label.textColor = [UIColor whiteColor];
        label.textAlignment = NSTextAlignmentCenter;
        label.adjustsFontSizeToFitWidth = NO;
        label.userInteractionEnabled = NO;
        // 1.5pt letter-spacing for slightly more breathing room.
        NSMutableAttributedString* attr =
            [[NSMutableAttributedString alloc] initWithString:label.text];
        [attr addAttribute:NSKernAttributeName value:@1.0
                     range:NSMakeRange(0, label.text.length)];
        [attr addAttribute:NSFontAttributeName value:label.font
                     range:NSMakeRange(0, label.text.length)];
        [attr addAttribute:NSForegroundColorAttributeName value:label.textColor
                     range:NSMakeRange(0, label.text.length)];
        label.attributedText = attr;
        [stripe addSubview:label];

        [self addSubview:stripe];

        // Position stripe so its centre sits on the diagonal that runs
        // from top-right corner toward the lower-left of the view.
        // Distance `kEnnioStripeFromCorner` along that diagonal from
        // the corner: (corner.x - d/√2, corner.y + d/√2).
        const CGFloat half = kEnnioStripeFromCorner * M_SQRT1_2;
        stripe.center = CGPointMake(kEnnioBannerSize - half, half);

        // +45° rotation = clockwise from the stripe's natural
        // horizontal orientation. With the stripe's centre on the
        // top-right diagonal, the rotated stripe lies along that
        // diagonal and "E2E" reads naturally with a 45° head tilt to
        // the right — matches Flutter's topEnd debug banner.
        stripe.transform = CGAffineTransformMakeRotation(M_PI_4);
    }
    return self;
}

@end

// ─────────────────────────────────────────────────────────────────────
// Public banner singleton.
// ─────────────────────────────────────────────────────────────────────

@interface EnnioDebugBanner ()
@property (nonatomic, strong, nullable) UIWindow* window;
@end

@implementation EnnioDebugBanner

+ (instancetype)shared {
    static EnnioDebugBanner* instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [[EnnioDebugBanner alloc] init];
    });
    return instance;
}

+ (void)show {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[self shared] attach];
    });
}

+ (void)hide {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[self shared] detach];
    });
}

- (void)attach {
    if (self.window) return;

    UIWindowScene* scene = [self foregroundScene];
    if (!scene) {
        // Scene not ready yet — retry shortly. RCTHost.start fires
        // before the first scene activates on cold launch.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                       dispatch_get_main_queue(),
                       ^{ [self attach]; });
        return;
    }

    UIWindow* w = [[EnnioPassthroughWindow alloc] initWithWindowScene:scene];
    w.windowLevel = UIWindowLevelStatusBar + 1;
    w.backgroundColor = [UIColor clearColor];
    w.userInteractionEnabled = NO;

    UIViewController* vc = [[UIViewController alloc] init];
    vc.view.backgroundColor = [UIColor clearColor];
    vc.view.userInteractionEnabled = NO;

    EnnioRibbonView* ribbon = [[EnnioRibbonView alloc] init];
    ribbon.translatesAutoresizingMaskIntoConstraints = NO;
    [vc.view addSubview:ribbon];

    // Pin to top-right corner of the window — outside the safe area on
    // purpose, matching Flutter's DEBUG banner that runs into the
    // status bar / notch area.
    [NSLayoutConstraint activateConstraints:@[
        [ribbon.topAnchor      constraintEqualToAnchor:vc.view.topAnchor],
        [ribbon.trailingAnchor constraintEqualToAnchor:vc.view.trailingAnchor],
        [ribbon.widthAnchor    constraintEqualToConstant:kEnnioBannerSize],
        [ribbon.heightAnchor   constraintEqualToConstant:kEnnioBannerSize],
    ]];

    w.rootViewController = vc;
    w.hidden = NO;
    self.window = w;
}

- (void)detach {
    // Null-safe: never shown (or already hidden) → nothing to do. The
    // retry path in `attach` keys off self.window too, so clearing it
    // here also cancels a pending re-attach.
    if (!self.window) return;
    self.window.hidden = YES;
    self.window.rootViewController = nil;
    self.window = nil;
}

- (UIWindowScene*)foregroundScene {
    for (UIScene* s in [UIApplication sharedApplication].connectedScenes) {
        if (![s isKindOfClass:[UIWindowScene class]]) continue;
        if (s.activationState == UISceneActivationStateForegroundActive ||
            s.activationState == UISceneActivationStateForegroundInactive) {
            return (UIWindowScene*)s;
        }
    }
    return nil;
}

@end
