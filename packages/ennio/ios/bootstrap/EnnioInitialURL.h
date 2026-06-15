//
// EnnioInitialURL.h
//
// Cold deep-link as the INITIAL url (ENNIO_INITIAL_URL).
//
// iOS delivers a launch-time deep link to react-navigation through
// RCTLinkingManager's getInitialURL, which it reads ONCE when the
// NavigationContainer mounts and turns into the initial navigation state
// (getStateFromPath) — REPLACING any state restored from disk. That is how
// `simctl openurl` cold-launched the playground onto the exact route.
//
// iOS 26 raises a blocking "Open in <app>?" SpringBoard confirmation for
// every `simctl openurl` that no headless runner can dismiss, so the cold
// path launches with `simctl launch` (no prompt) and hands the URL to the
// app out-of-band: this hook reads ENNIO_INITIAL_URL and makes
// getInitialURL resolve with it. Same precedence as a real launch URL —
// the deep-link route wins over restored state — with no openurl prompt and
// no `url`-event race (a pushed RCTOpenURLNotification subscribes only after
// the container mounts, so it lands ON TOP of restored state instead of
// replacing it).
//
// Opt-in: no env var ⇒ the hook never touches RCTLinkingManager. Non-RN
// hosts (no RCTLinkingManager class) are a no-op.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioInitialURL : NSObject

/// If ENNIO_INITIAL_URL is set, swizzle -[RCTLinkingManager
/// getInitialURL:reject:] to resolve with it. Idempotent; no-op without the
/// env var or without RCTLinkingManager.
+ (void)installIfEnabled;

@end

NS_ASSUME_NONNULL_END
