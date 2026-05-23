//
// EnnioHandlerUtils.mm — see header for design.
//

#import "EnnioHandlerUtils.h"

NSDictionary *EnnioParseArgs(const std::string &args) {
    if (args.empty()) return @{};
    NSData *data = [NSData dataWithBytes:args.data() length:args.size()];
    NSError *err = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
    if (err || ![parsed isKindOfClass:NSDictionary.class]) return nil;
    return (NSDictionary *)parsed;
}

NSString *EnnioArgString(NSDictionary *args, NSString *key) {
    id v = args[key];
    return [v isKindOfClass:NSString.class] ? (NSString *)v : nil;
}

double EnnioArgDouble(NSDictionary *args, NSString *key, double fallback) {
    id v = args[key];
    if ([v isKindOfClass:NSNumber.class]) return ((NSNumber *)v).doubleValue;
    return fallback;
}

int EnnioArgInt(NSDictionary *args, NSString *key, int fallback) {
    id v = args[key];
    if ([v isKindOfClass:NSNumber.class]) return ((NSNumber *)v).intValue;
    return fallback;
}

std::string EnnioBoolJson(BOOL b) { return b ? "true" : "false"; }

std::string EnnioStringJson(NSString *s) {
    if (!s) return "\"\"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[ s ?: @"" ]
                                                   options:0
                                                     error:nil];
    NSString *full = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (full.length < 4) return "\"\"";
    NSString *inner = [full substringWithRange:NSMakeRange(1, full.length - 2)];
    return std::string(inner.UTF8String);
}

std::string EnnioRectJson(EnnioRect r) {
    char buf[160];
    std::snprintf(buf, sizeof(buf),
                  "{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f}",
                  r.x, r.y, r.w, r.h);
    return std::string(buf);
}

std::string EnnioElapsedJson(uint32_t elapsedMs, BOOL ok) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "{\"ok\":%s,\"elapsedMs\":%u}",
                  ok ? "true" : "false", elapsedMs);
    return std::string(buf);
}

std::string EnnioStringArrayJson(NSArray<NSString *> *arr) {
    if (arr.count == 0) return "[]";
    NSData *data = [NSJSONSerialization dataWithJSONObject:arr options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return std::string(json.UTF8String);
}

void EnnioOnMainVoid(std::function<void()> fn) {
    if ([NSThread isMainThread]) {
        fn();
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            fn();
        });
    }
}
