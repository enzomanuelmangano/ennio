//
// EnnioInitialURL.mm — see header.
//

#import "EnnioInitialURL.h"

#import <objc/runtime.h>

// The URL to hand react-navigation as its initial deep link. Captured from
// ENNIO_INITIAL_URL at install time; read by the swizzled getInitialURL.
static NSString *g_initialURL = nil;

@implementation EnnioInitialURL

+ (void)installIfEnabled {
    const char *env = getenv("ENNIO_INITIAL_URL");
    if (env == NULL || env[0] == '\0') return;

    NSString *url = [NSString stringWithUTF8String:env];
    if (url.length == 0) return;

    // RCTLinkingManager is the native module backing JS `Linking` on both the
    // bridge and bridgeless runtimes. Absent ⇒ host isn't react-native ⇒ leave
    // it alone.
    Class cls = NSClassFromString(@"RCTLinkingManager");
    if (cls == Nil) {
        NSLog(@"[Ennio] ENNIO_INITIAL_URL set but RCTLinkingManager not present — "
              @"host is not react-native; ignoring");
        return;
    }

    // - (void)getInitialURL:(RCTPromiseResolveBlock)resolve
    //               reject:(RCTPromiseRejectBlock)reject
    // RCTPromiseResolveBlock is `void (^)(id result)`; RN resolves the JS
    // promise with the URL string (or nil). Replace the IMP wholesale: on the
    // cold path the launch URL is the answer, and getInitialURL is pulled once
    // at container mount, so there is nothing to chain to.
    SEL sel = NSSelectorFromString(@"getInitialURL:reject:");
    Method m = class_getInstanceMethod(cls, sel);
    if (m == NULL) {
        NSLog(@"[Ennio] ENNIO_INITIAL_URL set but -[RCTLinkingManager "
              @"getInitialURL:reject:] not found — RN version mismatch; ignoring");
        return;
    }

    g_initialURL = url;
    IMP newImp = imp_implementationWithBlock(^(__unused id self, id resolve, __unused id reject) {
        // Resolve the JS promise with the deep link. react-navigation feeds it
        // to getStateFromPath, building the initial state for the route.
        if (resolve) ((void (^)(id))resolve)(g_initialURL);
    });
    method_setImplementation(m, newImp);
    NSLog(@"[Ennio] initial deep link primed: %@", g_initialURL);
}

@end
