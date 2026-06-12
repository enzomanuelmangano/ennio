//
// EnnioShowTouches.mm — see header.
//

#import "EnnioShowTouches.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static const CGFloat kTouchDiameter = 38.0;
static const CGFloat kTrailDiameter = 9.0;
static const CGFloat kTrailSpacing = 14.0; // min pts between breadcrumb dots
static const NSTimeInterval kFadeOutS = 0.30;
static const NSTimeInterval kTrailFadeS = 0.45;

// =====================================================================
// Overlay window — full-screen, passthrough, never key.
// =====================================================================

@interface EnnioTouchOverlayWindow : UIWindow
@end

@implementation EnnioTouchOverlayWindow
// Never participate in hit-testing: every touch falls through to the
// app's own windows, so the overlay can't swallow or shift input.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    return nil;
}
@end

// =====================================================================
// Display-link fade animator — manual lerp, no CAAnimations.
// =====================================================================
//
// CAAnimation is off the table twice over: ENNIO_NO_ANIMATIONS would
// compress the fade to invisibility (the whole point of this mode is
// often "watch the run with everything else suppressed"), and layer
// animations are exactly what other tools' settle probes look for.

@interface EnnioFadeEntry : NSObject
@property(nonatomic, strong) UIView *view;
@property(nonatomic) CFTimeInterval startTs;
@property(nonatomic) NSTimeInterval duration;
@property(nonatomic) BOOL scaleUp; // lift ripple grows while fading
@end

@implementation EnnioFadeEntry
@end

@interface EnnioTouchAnimator : NSObject
@property(nonatomic, strong) CADisplayLink *link;
@property(nonatomic, strong) NSMutableArray<EnnioFadeEntry *> *entries;
- (void)fadeView:(UIView *)view duration:(NSTimeInterval)duration scaleUp:(BOOL)scaleUp;
@end

@implementation EnnioTouchAnimator

- (instancetype)init {
    if ((self = [super init])) {
        _entries = [NSMutableArray array];
        _link = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
        _link.paused = YES;
        [_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    }
    return self;
}

- (void)fadeView:(UIView *)view duration:(NSTimeInterval)duration scaleUp:(BOOL)scaleUp {
    EnnioFadeEntry *e = [EnnioFadeEntry new];
    e.view = view;
    e.startTs = CACurrentMediaTime();
    e.duration = duration;
    e.scaleUp = scaleUp;
    [self.entries addObject:e];
    self.link.paused = NO;
}

- (void)tick:(CADisplayLink *)link {
    CFTimeInterval now = CACurrentMediaTime();
    NSMutableArray<EnnioFadeEntry *> *done = [NSMutableArray array];
    for (EnnioFadeEntry *e in self.entries) {
        double t = (now - e.startTs) / e.duration;
        if (t >= 1.0) {
            [e.view removeFromSuperview];
            [done addObject:e];
            continue;
        }
        e.view.alpha = (CGFloat)(1.0 - t);
        if (e.scaleUp) {
            CGFloat s = (CGFloat)(1.0 + 0.6 * t);
            e.view.transform = CGAffineTransformMakeScale(s, s);
        }
    }
    [self.entries removeObjectsInArray:done];
    if (self.entries.count == 0) self.link.paused = YES;
}

@end

// =====================================================================
// Touch tracking state (main thread only — sendEvent: is main).
// =====================================================================

static BOOL g_enabled = NO;
static EnnioTouchOverlayWindow *g_overlay = nil;
static EnnioTouchAnimator *g_animator = nil;
// UITouch identity is stable for the touch's lifetime; weak keys let
// ended touches drop out even if a phase is missed.
static NSMapTable<UITouch *, UIView *> *g_indicators = nil;
static NSMapTable<UITouch *, NSValue *> *g_lastTrailPoint = nil;

static void (*g_origSendEvent)(id, SEL, UIEvent *) = NULL;

static UIView *makeCircle(CGFloat diameter, CGPoint center) {
    UIView *v =
        [[UIView alloc] initWithFrame:CGRectMake(0, 0, diameter, diameter)];
    v.center = center;
    v.layer.cornerRadius = diameter / 2;
    v.backgroundColor = [UIColor colorWithWhite:0.15 alpha:0.35];
    v.layer.borderColor = [UIColor colorWithWhite:1.0 alpha:0.9].CGColor;
    v.layer.borderWidth = 2.0;
    v.userInteractionEnabled = NO;
    v.isAccessibilityElement = NO;
    v.accessibilityElementsHidden = YES;
    return v;
}

/** Lazily (re)build the overlay on the active scene. A scene change
 *  (rare in a test app, but possible) orphans the old overlay — detect
 *  via the scene pointer and rebuild. */
static EnnioTouchOverlayWindow *_Nullable overlayForWindow(UIWindow *appWindow) {
    UIWindowScene *scene = appWindow.windowScene;
    if (!scene) return g_overlay;
    if (g_overlay && g_overlay.windowScene == scene) return g_overlay;
    EnnioTouchOverlayWindow *w = [[EnnioTouchOverlayWindow alloc] initWithWindowScene:scene];
    w.frame = scene.coordinateSpace.bounds;
    w.windowLevel = UIWindowLevelAlert + 500;
    w.backgroundColor = [UIColor clearColor];
    w.userInteractionEnabled = NO;
    w.accessibilityElementsHidden = YES;
    w.hidden = NO;
    g_overlay = w;
    return w;
}

static void handleTouches(UIEvent *event) {
    for (UITouch *touch in event.allTouches) {
        UIWindow *win = touch.window;
        if (!win) continue;
        EnnioTouchOverlayWindow *overlay = overlayForWindow(win);
        if (!overlay) continue;
        CGPoint p = [win convertPoint:[touch locationInView:nil] toWindow:overlay];

        switch (touch.phase) {
            case UITouchPhaseBegan: {
                UIView *dot = makeCircle(kTouchDiameter, p);
                [overlay addSubview:dot];
                [g_indicators setObject:dot forKey:touch];
                [g_lastTrailPoint setObject:[NSValue valueWithCGPoint:p] forKey:touch];
                break;
            }
            case UITouchPhaseMoved: {
                UIView *dot = [g_indicators objectForKey:touch];
                if (!dot) break;
                dot.center = p;
                // Breadcrumb trail: a small fading dot every ~kTrailSpacing
                // points makes swipe paths readable in recordings.
                NSValue *lastV = [g_lastTrailPoint objectForKey:touch];
                CGPoint last = lastV ? lastV.CGPointValue : p;
                CGFloat dx = p.x - last.x, dy = p.y - last.y;
                if (dx * dx + dy * dy >= kTrailSpacing * kTrailSpacing) {
                    UIView *crumb = makeCircle(kTrailDiameter, p);
                    crumb.layer.borderWidth = 0;
                    // Same dark fill as the head circle — a white crumb
                    // disappears on light screens.
                    crumb.backgroundColor = [UIColor colorWithWhite:0.15 alpha:0.5];
                    // Behind the finger circle so the head stays readable.
                    [overlay insertSubview:crumb belowSubview:dot];
                    [g_animator fadeView:crumb duration:kTrailFadeS scaleUp:NO];
                    [g_lastTrailPoint setObject:[NSValue valueWithCGPoint:p] forKey:touch];
                }
                break;
            }
            case UITouchPhaseEnded:
            case UITouchPhaseCancelled: {
                UIView *dot = [g_indicators objectForKey:touch];
                if (dot) {
                    dot.center = p;
                    [g_animator fadeView:dot duration:kFadeOutS scaleUp:YES];
                    [g_indicators removeObjectForKey:touch];
                }
                [g_lastTrailPoint removeObjectForKey:touch];
                break;
            }
            default:
                break;
        }
    }
}

static void ennio_sendEvent(id self, SEL _cmd, UIEvent *event) {
    // Deliver first — visualization must never delay or reorder input.
    if (g_origSendEvent) g_origSendEvent(self, _cmd, event);
    if (!g_enabled || event.type != UIEventTypeTouches) return;
    @try {
        handleTouches(event);
    } @catch (NSException *e) {
        // A drawing hiccup must never take the app down mid-run.
        NSLog(@"[Ennio] show-touches overlay error: %@", e.reason);
    }
}

// =====================================================================
// EnnioShowTouches
// =====================================================================

@implementation EnnioShowTouches

+ (void)installIfEnabled {
    const char *v = getenv("ENNIO_SHOW_TOUCHES");
    BOOL want = v != NULL && v[0] != '\0' && strcmp(v, "0") != 0;
    if (!want) return;

    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_indicators = [NSMapTable weakToStrongObjectsMapTable];
        g_lastTrailPoint = [NSMapTable weakToStrongObjectsMapTable];
        g_animator = [EnnioTouchAnimator new];

        Class cls = [UIApplication class];
        SEL sel = @selector(sendEvent:);
        Method m = class_getInstanceMethod(cls, sel);
        if (!m) return;
        g_origSendEvent = (void (*)(id, SEL, UIEvent *))method_getImplementation(m);
        method_setImplementation(m, (IMP)ennio_sendEvent);
        g_enabled = YES;
        NSLog(@"[Ennio] show-touches ON — touches drawn on a passthrough overlay");
    });
}

@end
