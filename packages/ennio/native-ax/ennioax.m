// ennioax — cross-process accessibility reader for the iOS simulator.
//
// The in-app dylib sees only its own process; system UI (permission
// sheets, the Photos picker, SpringBoard alerts) lives in other
// processes and is invisible to it. Simulator.app already bridges the
// booted device's iOS accessibility tree into its own macOS AX tree —
// but only once an AX client asks for the richer interface. We set
// `AXEnhancedUserInterface` to wake that bridge, then read the tree
// through the public ApplicationServices AXUIElement API. No private
// framework, no reverse-engineering of the AXPTranslation bridge.
//
// Output: JSON on stdout —
//   { "screen": {x,y,w,h},                      // device-screen macOS rect
//     "elements": [ {role,label,value,           // iOS element
//                    nx,ny,nw,nh, cx,cy} ] }     // normalized [0,1] frame + center
// `cx,cy` feed straight into the in-house HID (same [0,1] space).
//
// Requires: Simulator.app running + showing the device, and the
// controlling process trusted for Accessibility. Resolve device name
// from UDID via CoreSimulator so the right window is matched when
// several simulators are open.
//
// Usage: ennioax <UDID>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static NSString *axStr(AXUIElementRef e, CFStringRef a) {
  CFTypeRef v = NULL;
  if (AXUIElementCopyAttributeValue(e, a, &v) == kAXErrorSuccess && v) {
    NSString *s = [(__bridge id)v isKindOfClass:NSString.class] ? (__bridge NSString *)v
                                                                : [(__bridge id)v description];
    s = [s copy]; CFRelease(v); return s;
  }
  return nil;
}

static void axRect(AXUIElementRef e, CGPoint *p, CGSize *s) {
  CFTypeRef pv = NULL, sv = NULL; *p = CGPointZero; *s = CGSizeZero;
  if (AXUIElementCopyAttributeValue(e, kAXPositionAttribute, &pv) == kAXErrorSuccess && pv) {
    AXValueGetValue(pv, kAXValueCGPointType, p); CFRelease(pv);
  }
  if (AXUIElementCopyAttributeValue(e, kAXSizeAttribute, &sv) == kAXErrorSuccess && sv) {
    AXValueGetValue(sv, kAXValueCGSizeType, s); CFRelease(sv);
  }
}

// Resolve the booted device's display name from its UDID (CoreSimulator).
static NSString *deviceName(NSString *udid) {
  Class ctxCls = NSClassFromString(@"SimServiceContext");
  if (!ctxCls) return nil;
  NSString *dev = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"]
      ?: @"/Applications/Xcode.app/Contents/Developer";
  NSError *err = nil;
  SEL cs = @selector(sharedServiceContextForDeveloperDir:error:);
  id (*csf)(id, SEL, id, NSError **) = (void *)[ctxCls methodForSelector:cs];
  id ctx = csf(ctxCls, cs, dev, &err); if (!ctx) return nil;
  SEL ds = @selector(defaultDeviceSetWithError:);
  id (*dsf)(id, SEL, NSError **) = (void *)[ctx methodForSelector:ds];
  id set = dsf(ctx, ds, &err); if (!set) return nil;
  NSDictionary *by = [set valueForKey:@"devicesByUDID"];
  for (id k in by) {
    if ([[[k valueForKey:@"UUIDString"] uppercaseString] isEqual:udid.uppercaseString])
      return [by[k] valueForKey:@"name"];
  }
  return nil;
}

// Find the AXGroup whose subrole is the iOS content group (the device
// screen). Returns its element (out-param frame) or NULL.
static AXUIElementRef findScreen(AXUIElementRef e, int depth) {
  if (depth > 8) return NULL;
  NSString *sub = axStr(e, kAXSubroleAttribute);
  if ([sub isEqual:@"iOSContentGroup"]) return (AXUIElementRef)CFRetain(e);
  CFTypeRef kids = NULL; AXUIElementRef found = NULL;
  if (AXUIElementCopyAttributeValue(e, kAXChildrenAttribute, &kids) == kAXErrorSuccess && kids) {
    for (id c in (__bridge NSArray *)kids) {
      found = findScreen((__bridge AXUIElementRef)c, depth + 1);
      if (found) break;
    }
    CFRelease(kids);
  }
  return found;
}

static NSString *jsonEsc(NSString *s) {
  if (!s) return @"";
  NSMutableString *m = [s mutableCopy];
  [m replaceOccurrencesOfString:@"\\" withString:@"\\\\" options:0 range:NSMakeRange(0, m.length)];
  [m replaceOccurrencesOfString:@"\"" withString:@"\\\"" options:0 range:NSMakeRange(0, m.length)];
  [m replaceOccurrencesOfString:@"\n" withString:@" " options:0 range:NSMakeRange(0, m.length)];
  [m replaceOccurrencesOfString:@"\t" withString:@" " options:0 range:NSMakeRange(0, m.length)];
  return m;
}

static void collect(AXUIElementRef e, CGPoint g, CGSize gs, NSMutableArray *out, int depth) {
  if (depth > 24) return;
  NSString *role = axStr(e, kAXRoleAttribute);
  NSString *title = axStr(e, kAXTitleAttribute);
  NSString *desc = axStr(e, kAXDescriptionAttribute);
  NSString *val = axStr(e, kAXValueAttribute);
  NSString *ident = axStr(e, CFSTR("AXIdentifier")); // iOS testID bridges here
  NSString *label = title.length ? title : (desc.length ? desc : nil);
  if ((label || ident.length) && gs.width > 0 && gs.height > 0) {
    CGPoint p; CGSize s; axRect(e, &p, &s);
    double nx = (p.x - g.x) / gs.width, ny = (p.y - g.y) / gs.height;
    double nw = s.width / gs.width, nh = s.height / gs.height;
    double cx = nx + nw / 2, cy = ny + nh / 2;
    // We walk the whole device window (not just iOSContentGroup) so
    // native overlays — the image cropper, share sheet — are included.
    // The window also holds hardware-button / toolbar chrome at the
    // edges; drop anything whose center falls outside the screen rect.
    if (cx < -0.02 || cx > 1.02 || cy < -0.02 || cy > 1.02) goto descend;
    [out addObject:[NSString stringWithFormat:
      @"{\"role\":\"%@\",\"label\":\"%@\",\"id\":\"%@\",\"value\":\"%@\",\"nx\":%.4f,\"ny\":%.4f,\"nw\":%.4f,\"nh\":%.4f,\"cx\":%.4f,\"cy\":%.4f}",
      jsonEsc(role), jsonEsc(label ?: @""), jsonEsc(ident ?: @""), jsonEsc(val.length ? val : @""), nx, ny, nw, nh, cx, cy]];
  }
descend:;
  CFTypeRef kids = NULL;
  if (AXUIElementCopyAttributeValue(e, kAXChildrenAttribute, &kids) == kAXErrorSuccess && kids) {
    for (id c in (__bridge NSArray *)kids) collect((__bridge AXUIElementRef)c, g, gs, out, depth + 1);
    CFRelease(kids);
  }
}

// Walk the device window once and emit a JSON line. `warm` skips the
// long first-arm settle (the bridge is already armed from a prior dump);
// a still-empty read re-arms with a short settle and retries. Returns
// the JSON string (one line, no newline).
static NSString *dumpTree(AXUIElementRef app, NSString *name, BOOL warm) {
  CGPoint g = CGPointZero; CGSize gs = CGSizeZero;
  NSMutableArray *els = [NSMutableArray new];
  for (int attempt = 0; attempt < 3; attempt++) {
    // Arm on the first attempt only when cold, then on every retry — a
    // warm process keeps AXEnhancedUserInterface set, so the steady-state
    // dump skips the re-arm + long settle entirely.
    if (!warm || attempt > 0) {
      AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
      usleep((warm || attempt > 0) ? 120000 : 400000);
    }
    AXUIElementRef screen = NULL, window = NULL;
    CFTypeRef wins = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &wins) == kAXErrorSuccess && wins) {
      for (id w in (__bridge NSArray *)wins) {
        NSString *t = axStr((__bridge AXUIElementRef)w, kAXTitleAttribute);
        if (!t.length) continue;
        if (name.length && ![t hasPrefix:name]) continue;
        screen = findScreen((__bridge AXUIElementRef)w, 0);
        if (screen) { window = (AXUIElementRef)CFRetain((__bridge AXUIElementRef)w); break; }
      }
      CFRelease(wins);
    }
    if (!screen) { if (window) CFRelease(window); continue; }
    axRect(screen, &g, &gs);
    [els removeAllObjects];
    collect(window ?: screen, g, gs, els, 0);
    CFRelease(screen); if (window) CFRelease(window);
    if (els.count > 0) break;
  }
  return [NSString stringWithFormat:
    @"{\"screen\":{\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f},\"elements\":[%s]}",
    g.x, g.y, gs.width, gs.height, [[els componentsJoinedByString:@","] UTF8String]];
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "usage: ennioax <UDID> [--persistent]\n"); return 2; }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    BOOL persistent = (argc >= 3 && strcmp(argv[2], "--persistent") == 0);

    if (!AXIsProcessTrusted()) {
      fprintf(stderr, "ennioax: process not trusted for Accessibility — grant it in System Settings > Privacy & Security > Accessibility\n");
      printf("{\"error\":\"not-ax-trusted\"}\n"); return 3;
    }
    NSRunningApplication *sim = nil;
    for (NSRunningApplication *a in NSWorkspace.sharedWorkspace.runningApplications)
      if ([a.bundleIdentifier isEqual:@"com.apple.iphonesimulator"]) { sim = a; break; }
    if (!sim) { printf("{\"error\":\"simulator-not-running\"}\n"); return 4; }

    AXUIElementRef app = AXUIElementCreateApplication(sim.processIdentifier);
    NSString *name = deviceName(udid); // may be nil → match any window

    if (!persistent) {
      // One-shot (back-compat): single dump, exit.
      printf("%s\n", [dumpTree(app, name, NO) UTF8String]);
      CFRelease(app);
      return 0;
    }

    // Persistent mode: arm once, then serve "dump" commands over stdin so
    // the spawn + re-arm + settle cost is paid once, not per call.
    AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    usleep(400000);
    printf("ready\n"); fflush(stdout);
    char line[64];
    while (fgets(line, sizeof(line), stdin)) {
      @autoreleasepool {
        if (strncmp(line, "quit", 4) == 0) break;
        if (strncmp(line, "dump", 4) == 0) {
          printf("%s\n", [dumpTree(app, name, YES) UTF8String]);
          fflush(stdout);
        }
      }
    }
    CFRelease(app);
    return 0;
  }
}
