//
// EnnioBootstrap.h
//
// Entry point for the in-app ennio dylib. +load installs the Unix socket
// listener and registers for UIApplicationDidFinishLaunchingNotification.
// On app-launched: captures key window, starts settle observers, marks
// the bootstrap "ready" so dispatched commands have UIKit to work on.
//
// Pure UIKit / CoreFoundation. No React Native references. No JSI. No
// private RN ABI. Works on any iOS Debug app.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioBootstrap : NSObject

/// YES once UIApplicationDidFinishLaunchingNotification has fired and
/// the key UIWindow is available for queries.
+ (BOOL)isReady;

/// The first key UIWindow discovered after app launch. nil before launch
/// completes or on the simulator's initial empty scene.
+ (nullable UIWindow *)keyWindow;

@end

NS_ASSUME_NONNULL_END
