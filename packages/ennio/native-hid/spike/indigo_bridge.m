// Indigo digitizer bridge — the R1 unknown.
//
// First attempt: build an IOHIDEvent digitizer-finger event with
// public IOKit, hand it to SimulatorKit's
// IndigoHIDMessageForPointerEventFromHIDEventRef, then send via the
// SimDeviceLegacyHIDClient. If the "pointer" builder produces a mouse
// event rather than a finger touch, fall back path (next iteration):
// hand-build the Indigo digitizer struct from idb's published
// IndigoHID.h layout.
//
// This file exists to make the spike COMPILE and surface the real
// symbol/ABI behavior — the success criterion is a real onPress in the
// example app, validated by running, not by reading.

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>

// IOHIDEvent digitizer creation (IOKit private but long-stable).
typedef struct __IOHIDEvent *IOHIDEventRef;
extern IOHIDEventRef IOHIDEventCreateDigitizerFingerEvent(
    CFAllocatorRef allocator, uint64_t timeStamp, uint32_t index,
    uint32_t identity, uint32_t eventMask, CGFloat x, CGFloat y, CGFloat z,
    CGFloat tipPressure, CGFloat twist, Boolean range, Boolean touch,
    uint32_t options);

// SimulatorKit C builder + the Swift client's send. Resolved at runtime
// via dlsym against the already-linked SimulatorKit image so we don't
// need its (Swift-mangled) headers.
typedef void *(*IndigoMsgForPointerFn)(IOHIDEventRef, uint32_t);

// kIOHIDDigitizerEventTouch | kIOHIDDigitizerEventRange | position
enum { kEventRange = 0x0001, kEventTouch = 0x0002, kEventPosition = 0x0004 };

static void *symbol(const char *name) {
    void *s = dlsym(RTLD_DEFAULT, name);
    if (!s) {
        fprintf(stderr, "[bridge] dlsym miss: %s\n", name);
    }
    return s;
}

// Returns 1 on send success, 0 on any failure. xNorm/yNorm in 0..1.
int enniohid_send_touch(id hidClient, double xNorm, double yNorm) {
    IndigoMsgForPointerFn buildMsg =
        (IndigoMsgForPointerFn)symbol("IndigoHIDMessageForPointerEventFromHIDEventRef");
    if (!buildMsg) {
        fprintf(stderr, "[bridge] no pointer-event builder; digitizer struct path needed\n");
        return 0;
    }

    // The SimDeviceLegacyHIDClient.send(message:) Swift method is not
    // directly callable from ObjC. Probe whether an ObjC-visible
    // shim selector exists; if not, report so the next iteration
    // wires the Swift call site in main.swift instead.
    SEL sendSel = NSSelectorFromString(@"sendMessage:freeWhenDone:completionQueue:completion:");
    if (![hidClient respondsToSelector:sendSel]) {
        fprintf(stderr, "[bridge] client has no ObjC send shim — call send() from Swift side\n");
        return 0;
    }

    uint64_t ts = mach_absolute_time();
    for (int down = 1; down >= 0; down--) {
        IOHIDEventRef ev = IOHIDEventCreateDigitizerFingerEvent(
            kCFAllocatorDefault, ts, 1 /*index*/, 2 /*identity*/,
            kEventRange | kEventTouch | kEventPosition,
            (CGFloat)xNorm, (CGFloat)yNorm, 0.0,
            down ? 1.0 : 0.0, 0.0, down ? true : false, down ? true : false, 0);
        if (!ev) { fprintf(stderr, "[bridge] IOHIDEvent create failed\n"); return 0; }
        void *msg = buildMsg(ev, 0);
        if (!msg) { fprintf(stderr, "[bridge] buildMsg returned NULL\n"); CFRelease((CFTypeRef)ev); return 0; }
        ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(
            hidClient, sendSel, msg, YES, nil, nil);
        CFRelease((CFTypeRef)ev);
        ts += 16000000; // ~16ms between down and up
    }
    return 1;
}
