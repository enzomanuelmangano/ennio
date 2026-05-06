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
// Ribbon view: 90x90 anchored top-right. Custom drawRect renders a red
// 22pt-wide diagonal stripe rotated -45°, with bold white "E2E" text
// centered along the stripe.
// ─────────────────────────────────────────────────────────────────────

@interface EnnioRibbonView : UIView
@end

@implementation EnnioRibbonView

- (instancetype)init {
    self = [super initWithFrame:CGRectMake(0, 0, 130, 130)];
    if (self) {
        self.backgroundColor = [UIColor clearColor];
        self.opaque = NO;
        self.userInteractionEnabled = NO;
        self.clipsToBounds = NO;
    }
    return self;
}

- (void)drawRect:(CGRect)rect {
    CGContextRef ctx = UIGraphicsGetCurrentContext();
    CGContextSaveGState(ctx);

    // Anchor coordinate system at the view's top-right corner, rotate
    // -45° so a horizontal rect we draw next reads as the diagonal
    // ribbon coming out of that corner.
    CGContextTranslateCTM(ctx, rect.size.width, 0);
    CGContextRotateCTM(ctx, -M_PI_4);

    const CGFloat ribbonWidth  = 26;
    const CGFloat ribbonLength = 200;
    const CGFloat ribbonOffset = 28; // distance from corner along diagonal
    CGRect ribbon = CGRectMake(-ribbonLength / 2.0,
                                ribbonOffset,
                                ribbonLength,
                                ribbonWidth);

    // Slight shadow so the ribbon stays legible over white/light app
    // backgrounds.
    CGContextSetShadowWithColor(ctx, CGSizeMake(0, 1), 2,
        [[UIColor colorWithWhite:0 alpha:0.35] CGColor]);
    CGContextSetFillColorWithColor(ctx, [[UIColor systemRedColor] CGColor]);
    CGContextFillRect(ctx, ribbon);
    CGContextSetShadowWithColor(ctx, CGSizeZero, 0, NULL);

    // Centered "E2E" label, white bold, sized to fit the stripe height.
    NSDictionary* attrs = @{
        NSFontAttributeName: [UIFont systemFontOfSize:13 weight:UIFontWeightBold],
        NSForegroundColorAttributeName: [UIColor whiteColor],
        NSKernAttributeName: @1.5,
    };
    NSString* text = @"E2E";
    CGSize textSize = [text sizeWithAttributes:attrs];
    // Position text along the visible portion of the rotated ribbon.
    // After -45° rotation the +x axis points up-and-right (outside the
    // view), so anything drawn at local x ≥ 0 falls past the view's
    // right edge and clips. Shift the text into negative local x so
    // it lands on the diagonal stripe inside the view bounds.
    const CGFloat textShiftX = -55;
    CGPoint textPos = CGPointMake(textShiftX - textSize.width / 2.0,
                                   ribbonOffset + (ribbonWidth - textSize.height) / 2.0);
    [text drawAtPoint:textPos withAttributes:attrs];

    CGContextRestoreGState(ctx);
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
        [ribbon.widthAnchor    constraintEqualToConstant:130],
        [ribbon.heightAnchor   constraintEqualToConstant:130],
    ]];

    w.rootViewController = vc;
    w.hidden = NO;
    self.window = w;
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
