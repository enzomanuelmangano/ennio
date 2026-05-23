//
// EnnioReactObserver.mm — see header for strategy.
//

#import "EnnioReactObserver.h"

#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach/mach_time.h>

static NSCondition *g_cond;
static uint64_t g_lastCommitMs = 0;
static bool g_paperAttached = false;
static bool g_fabricAttached = false;

static uint64_t nowMs(void) {
    static mach_timebase_info_data_t info = {0, 0};
    if (info.denom == 0) mach_timebase_info(&info);
    return (mach_absolute_time() * info.numer / info.denom) / 1000000ULL;
}

static void markCommit(void) {
    [g_cond lock];
    g_lastCommitMs = nowMs();
    [g_cond broadcast];
    [g_cond unlock];
}

// =====================================================================
// Paper: RCTUIManagerDidUpdateViewsNotification
// =====================================================================

static bool attachPaperObserver(void) {
    // Notification name is a string constant in RN; we observe by name
    // so we don't link against React.
    NSString *name = @"RCTUIManagerDidUpdateViewsNotification";
    [[NSNotificationCenter defaultCenter] addObserverForName:name
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification * _Nonnull note) {
        (void)note;
        markCommit();
    }];
    return true;
}

// =====================================================================
// Fabric: swizzle RCTMountingManager.performTransaction:
// =====================================================================
//
// Fabric's mount path lands in RCTMountingManager. The exact method
// signature has shifted between RN versions; we look up the class and
// any method whose selector starts with "performTransaction" or
// "_performTransaction" and wrap it.
//
// If the swizzle target is missing we silently bail. The CLI logs
// attachmentDescription() so the user can see whether Fabric attached.

static IMP g_origMountImp = NULL;
static SEL g_mountSel = NULL;

static void swizzledMountImp(id self, SEL _cmd, id arg) {
    using FnT = void (*)(id, SEL, id);
    if (g_origMountImp) {
        ((FnT)g_origMountImp)(self, _cmd, arg);
    }
    markCommit();
    static int counter = 0;
    if (++counter <= 5 || (counter % 50 == 0)) {
        NSLog(@"[Ennio] RN commit signal #%d", counter);
    }
}

static NSString *g_fabricClassName = nil;
static NSString *g_fabricSelName = nil;

static bool tryAttachOnClass(Class cls, NSArray<NSString *> *selCandidates) {
    if (!cls) return false;
    for (NSString *selName in selCandidates) {
        SEL s = NSSelectorFromString(selName);
        Method m = class_getInstanceMethod(cls, s);
        if (m) {
            g_origMountImp = method_getImplementation(m);
            method_setImplementation(m, (IMP)swizzledMountImp);
            g_mountSel = s;
            g_fabricClassName = NSStringFromClass(cls);
            g_fabricSelName = selName;
            NSLog(@"[Ennio] RN observer: attached to %@ %@", g_fabricClassName, g_fabricSelName);
            return true;
        }
    }
    return false;
}

static bool attachFabricSwizzle(void) {
    // RN Fabric / new-arch class candidates. Different RN versions land
    // commits on different objects — try several, attach to the first
    // that has a matching mount-style selector.
    NSArray *classMethods = @[
        // Paper (legacy bridge). flushUIBlocksWithCompletion: runs every
        // batch of UIView mutations RN computes — equivalent to one
        // commit. Selector is stable across RN ≥0.60 paper builds.
        @[ @"RCTUIManager", @[ @"flushUIBlocksWithCompletion:",
                               @"_layoutAndMount" ] ],
        // Fabric / new arch.
        @[ @"RCTMountingManager", @[ @"scheduleTransaction:",
                                     @"performTransaction:",
                                     @"_performTransaction:",
                                     @"performMountInstructions:",
                                     @"didMountComponentsWithRootTag:" ] ],
        @[ @"RCTSurfacePresenter", @[ @"_performMountInstructions:rootTag:",
                                      @"runtimeSchedulerDidPerformWork" ] ],
        @[ @"RCTScheduler", @[ @"runtimeSchedulerTaskDone" ] ],
    ];
    for (NSArray *pair in classMethods) {
        Class cls = NSClassFromString(pair[0]);
        if (cls && tryAttachOnClass(cls, pair[1])) return true;
    }
    // Last attempt: enumerate all RCTMountingManager methods and attach
    // to the first one containing "ransaction" (handles performTransaction,
    // scheduleTransaction, didCompleteTransaction, etc).
    Class mm = NSClassFromString(@"RCTMountingManager");
    if (mm) {
        unsigned int n = 0;
        Method *list = class_copyMethodList(mm, &n);
        NSMutableArray *all = [NSMutableArray new];
        for (unsigned int i = 0; i < n; i++) {
            const char *s = sel_getName(method_getName(list[i]));
            [all addObject:@(s)];
        }
        free(list);
        NSLog(@"[Ennio] RCTMountingManager methods: %@", all);
    }
    // Last-resort instrumentation: list every Class whose name contains
    // "RCT" + "Mount" so the developer can see what's actually loaded
    // when none of the candidates matched. Fired once.
    int count = objc_getClassList(NULL, 0);
    if (count > 0) {
        Class *list = (Class *)malloc(sizeof(Class) * count);
        count = objc_getClassList(list, count);
        NSMutableArray *hits = [NSMutableArray new];
        for (int i = 0; i < count; i++) {
            const char *n = class_getName(list[i]);
            if (strstr(n, "Mount") || strstr(n, "RCTSurface") || strstr(n, "RCTScheduler")) {
                [hits addObject:@(n)];
            }
        }
        free(list);
        if (hits.count) NSLog(@"[Ennio] RN observer: no candidate matched; mount-like classes loaded: %@", hits);
        else NSLog(@"[Ennio] RN observer: no mount-like classes loaded yet");
    }
    return false;
}

// =====================================================================
// EnnioReactObserver
// =====================================================================

@implementation EnnioReactObserver

+ (void)start {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_cond = [NSCondition new];
        // RN may not be fully loaded yet at dylib-init time. Defer attach
        // to didFinishLaunching + retry once after 500 ms in case the
        // host loads Fabric lazily.
        dispatch_async(dispatch_get_main_queue(), ^{
            g_paperAttached = attachPaperObserver();
            g_fabricAttached = attachFabricSwizzle();
            // RN mounts a Fabric scheduler/mounting-manager only after
            // the JS bundle starts executing — for a Hermes cold start
            // that's hundreds of ms after didFinishLaunching. Retry on
            // a delay so we catch it.
            if (!g_fabricAttached) {
                for (int i = 0; i < 6; i++) {
                    double delay = 0.5 * (i + 1);
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                                   dispatch_get_main_queue(), ^{
                        if (!g_fabricAttached) g_fabricAttached = attachFabricSwizzle();
                    });
                }
            }
        });
    });
}

+ (uint64_t)lastCommitMs {
    return g_lastCommitMs;
}

/// Wait until React has been quiet for stableMs (no commits observed
/// for that long), or until maxMs elapses. Returns 1 if quiet was
/// reached, 0 if the timeout fired while commits were still arriving.
+ (BOOL)waitForReactQuietStableMs:(uint32_t)stableMs maxMs:(uint32_t)maxMs {
    if (!g_paperAttached && !g_fabricAttached) return YES;
    uint64_t start = nowMs();
    [g_cond lock];
    while (true) {
        uint64_t now = nowMs();
        uint64_t sinceCommit = now - g_lastCommitMs;
        if (sinceCommit >= stableMs) {
            [g_cond unlock];
            return YES;
        }
        uint64_t totalElapsed = now - start;
        if (totalElapsed >= maxMs) {
            [g_cond unlock];
            return NO;
        }
        uint64_t waitMs = stableMs - sinceCommit;
        uint64_t remaining = maxMs - totalElapsed;
        if (waitMs > remaining) waitMs = remaining;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)waitMs / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
}

+ (uint32_t)waitForCommitSince:(uint64_t)sinceMs maxMs:(uint32_t)maxMs {
    // No observer attached → bail; caller falls back to hash polling.
    if (!g_paperAttached && !g_fabricAttached) return 0;

    uint64_t start = nowMs();
    [g_cond lock];
    while (g_lastCommitMs <= sinceMs) {
        uint64_t now = nowMs();
        uint64_t elapsed = now - start;
        if (elapsed >= maxMs) break;
        uint64_t remaining = maxMs - elapsed;
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(NSTimeInterval)remaining / 1000.0];
        [g_cond waitUntilDate:deadline];
    }
    [g_cond unlock];
    return (uint32_t)(nowMs() - start);
}

+ (NSString *)attachmentDescription {
    if (g_paperAttached && g_fabricAttached) return @"both";
    if (g_paperAttached) return @"paper";
    if (g_fabricAttached) return @"fabric";
    return @"none";
}

@end
