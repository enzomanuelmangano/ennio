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
// Fabric: swizzle a mount/commit method — signature-checked.
// =====================================================================
//
// Fabric's mount path lands in RCTMountingManager and friends. The
// exact method signature has shifted between RN versions, and several
// candidates take C++ arguments (e.g. scheduleTransaction: takes a
// std::shared_ptr<const MountingCoordinator>). Forwarding those
// through an id-typed wrapper is undefined behaviour twice over:
//
//   1. ARC emits objc_retain on the wrapper's id parameter — a retain
//      on an NSInteger or a shared_ptr slot is a retain on garbage.
//   2. Non-trivial C++ by-value args are passed indirectly; a blind
//      (id, SEL, id) cast only preserves them by ABI luck, and luck
//      ran out on RN 0.85 (issue #44: SIGSEGV under injection).
//
// So before attaching we parse the method's type encoding and ONLY
// swizzle when the shape is provably forwardable:
//
//   - void return, AND
//   - zero args, or exactly one single-register pointer/integer arg
//     (objects, blocks, SELs, raw pointers, ints, bools).
//
// The one-arg wrapper takes `void *` — bit-pattern passthrough, no
// ARC traffic. Anything else (C++ structs, floats, multi-arg) is
// skipped with a log line, and we fall through to the next candidate.
// If nothing safe matches we attach nothing: waitForCommitSince
// returns 0 and the CLI falls back to hash polling. Slower settle
// beats a corrupted host app.

static IMP g_origMountImp = NULL;
static SEL g_mountSel = NULL;

static void logCommitSignal(void) {
    static int counter = 0;
    if (++counter <= 5 || (counter % 50 == 0)) {
        NSLog(@"[Ennio] RN commit signal #%d", counter);
    }
}

static void swizzledMountImp0(id self, SEL _cmd) {
    using FnT = void (*)(id, SEL);
    if (g_origMountImp) {
        ((FnT)g_origMountImp)(self, _cmd);
    }
    markCommit();
    logCommitSignal();
}

static void swizzledMountImp1(id self, SEL _cmd, void *arg) {
    using FnT = void (*)(id, SEL, void *);
    if (g_origMountImp) {
        ((FnT)g_origMountImp)(self, _cmd, arg);
    }
    markCommit();
    logCommitSignal();
}

/// Classify a method's type encoding. Returns the matching wrapper
/// IMP, or NULL when the signature is not safe to forward.
static IMP wrapperForEncoding(const char *enc) {
    if (!enc) return NULL;
    NSMethodSignature *sig = nil;
    @try {
        sig = [NSMethodSignature signatureWithObjCTypes:enc];
    } @catch (NSException *e) {
        return NULL; // unparseable (heavy C++ template encoding)
    }
    if (!sig) return NULL;
    if (strcmp(sig.methodReturnType, "v") != 0) return NULL;
    NSUInteger n = sig.numberOfArguments; // includes self + _cmd
    if (n == 2) return (IMP)swizzledMountImp0;
    if (n != 3) return NULL;
    // Single-register pointer/integer encodings only. Structs `{`,
    // unions `(`, and floats `f`/`d` are rejected — they don't
    // survive a void* passthrough. C++ by-const-ref args encode as
    // qualified pointers (`r^v` — e.g. Fabric's
    // performTransaction:(MountingCoordinator::Shared const &)) and
    // ARE single-register safe, so strip qualifier prefixes first.
    const char *argType = [sig getArgumentTypeAtIndex:2];
    while (*argType == 'r' || *argType == 'n' || *argType == 'N' || *argType == 'o' ||
           *argType == 'O' || *argType == 'R' || *argType == 'V') {
        argType++;
    }
    switch (argType[0]) {
        case '@': // object (also covers blocks: "@?")
        case '#': // Class
        case ':': // SEL
        case '^': // pointer
        case '*': // char *
        case 'q': case 'Q': case 'i': case 'I':
        case 'l': case 'L': case 's': case 'S':
        case 'c': case 'C': case 'B':
            return (IMP)swizzledMountImp1;
        default:
            return NULL;
    }
}

static NSString *g_fabricClassName = nil;
static NSString *g_fabricSelName = nil;

static bool tryAttachOnClass(Class cls, NSArray<NSString *> *selCandidates) {
    if (!cls) return false;
    for (NSString *selName in selCandidates) {
        SEL s = NSSelectorFromString(selName);
        Method m = class_getInstanceMethod(cls, s);
        if (!m) continue;
        const char *enc = method_getTypeEncoding(m);
        IMP wrapper = wrapperForEncoding(enc);
        if (!wrapper) {
            NSLog(@"[Ennio] RN observer: skipping %@ %@ — unsafe signature \"%s\"",
                  NSStringFromClass(cls), selName, enc ?: "?");
            continue;
        }
        g_origMountImp = method_getImplementation(m);
        method_setImplementation(m, wrapper);
        g_mountSel = s;
        g_fabricClassName = NSStringFromClass(cls);
        g_fabricSelName = selName;
        NSLog(@"[Ennio] RN observer: attached to %@ %@ (encoding \"%s\")",
              g_fabricClassName, g_fabricSelName, enc);
        return true;
    }
    return false;
}

static bool attachFabricSwizzle(void) {
    // RN class candidates. Different RN versions land commits on
    // different objects — try several, attach to the first that has a
    // selector with a provably-forwardable signature.
    //
    // Fabric candidates come FIRST: on New-Architecture apps the
    // interop layer still loads RCTUIManager, so a Paper-first order
    // attaches to a selector that never fires there — the observer
    // looks attached while settle silently runs on the hash-polling
    // fallback. On true Paper apps the Fabric classes don't exist and
    // we fall through to RCTUIManager as before. Attaching Fabric's
    // mount methods is safe now that signatures are encoding-checked
    // (C++ by-value args are rejected, const& pointers forward as-is).
    NSArray *classMethods = @[
        // Fabric / new arch.
        @[ @"RCTMountingManager", @[ @"scheduleTransaction:",
                                     @"performTransaction:",
                                     @"_performTransaction:",
                                     @"performMountInstructions:",
                                     @"didMountComponentsWithRootTag:" ] ],
        @[ @"RCTSurfacePresenter", @[ @"_performMountInstructions:rootTag:",
                                      @"runtimeSchedulerDidPerformWork" ] ],
        @[ @"RCTScheduler", @[ @"runtimeSchedulerTaskDone" ] ],
        // Paper (legacy bridge). flushUIBlocksWithCompletion: runs every
        // batch of UIView mutations RN computes — equivalent to one
        // commit. Selector is stable across RN ≥0.60 paper builds.
        @[ @"RCTUIManager", @[ @"flushUIBlocksWithCompletion:",
                               @"_layoutAndMount" ] ],
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
