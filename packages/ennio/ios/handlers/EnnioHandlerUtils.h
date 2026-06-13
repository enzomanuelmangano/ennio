//
// EnnioHandlerUtils.h
//
// Shared parse / encode helpers for the socket-handler files in this
// folder. Every handler converts a JSON `args` string into an
// NSDictionary, reads typed fields, and emits a JSON response — the
// helpers below remove the boilerplate so each handler file stays
// focused on its op semantics.
//
// Why a separate header instead of #defines or inline functions:
// these touch NSDictionary / NSString, so they must live in an
// Objective-C++ translation unit. Declared here, defined in the
// matching .mm so multiple handler .mm files share one
// implementation (avoids ODR issues from static inline ObjC code).
//

#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#include <functional>
#include <string>

#import "EnnioFinder.h"

NS_ASSUME_NONNULL_BEGIN

// =====================================================================
// JSON parse helpers — `args` is always a JSON object literal.
// =====================================================================

// `args` is genuinely nullable: callers pass EnnioParseArgs's result
// straight in (nil on malformed JSON) and these helpers nil-tolerate via
// objc messaging — so annotate it honestly rather than letting the
// NS_ASSUME_NONNULL default claim _Nonnull.
NSDictionary *_Nullable EnnioParseArgs(const std::string &args);
NSString *_Nullable EnnioArgString(NSDictionary *_Nullable args, NSString *key);
double EnnioArgDouble(NSDictionary *_Nullable args, NSString *key, double fallback);
int EnnioArgInt(NSDictionary *_Nullable args, NSString *key, int fallback);

// =====================================================================
// JSON emit helpers — return string literals the socket can ship as-is.
// =====================================================================

std::string EnnioBoolJson(BOOL b);
/// Returns a properly-quoted JSON string literal including surrounding
/// quotes. Use as the VALUE in `{"key": <stringJson(...)>}`, never wrap
/// in additional quotes at the call site.
std::string EnnioStringJson(NSString *_Nullable s);
std::string EnnioRectJson(EnnioRect r);
std::string EnnioElapsedJson(uint32_t elapsedMs, BOOL ok);
std::string EnnioStringArrayJson(NSArray<NSString *> *_Nullable arr);

// =====================================================================
// Main-thread bounce — runs `fn` on the main queue if not already
// there. Callers capture outputs by-reference inside the lambda.
// =====================================================================

void EnnioOnMainVoid(std::function<void()> fn);

NS_ASSUME_NONNULL_END
