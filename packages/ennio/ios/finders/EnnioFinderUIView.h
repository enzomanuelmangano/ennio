//
// EnnioFinderUIView.h
//
// Last-resort finder. Walks the UIWindow tree + every presented-VC
// chain. Catches host code that bypassed
// setAccessibilityIdentifier (KVC ivar writes, runtime swizzles) and
// non-RN apps entirely.
//
// Thin facade around the legacy EnnioFinder which already does the
// recursive walk + cross-window enumeration. Kept as its own class so
// EnnioFinderManager can name it explicitly in the strategy chain.
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EnnioFinderUIView : NSObject

+ (UIView *_Nullable)findByTestID:(NSString *)testID;
+ (UIView *_Nullable)findByText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
