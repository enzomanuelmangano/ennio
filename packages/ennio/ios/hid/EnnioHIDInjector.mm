//
// EnnioHIDInjector.mm — see header.
//

#import "EnnioHIDInjector.h"
#import "EnnioBootstrap.h"

#import <UIKit/UIKit.h>
#import <mach/mach_time.h>
#import <objc/message.h>

// ── IOKit IOHIDEvent digitizer API (private, long-stable) ───────────
// Declared here rather than #import <IOKit/hid/...> because the
// digitizer creators aren't in the public SDK. Signatures match the
// IOKitUser headers used by KIF / EarlGrey for ~a decade.

typedef double IOHIDFloat;
typedef uint32_t IOOptionBits;
typedef struct __IOHIDEvent *IOHIDEventRef;

typedef enum {
    kIOHIDDigitizerTransducerTypeStylus = 0,
    kIOHIDDigitizerTransducerTypePuck,
    kIOHIDDigitizerTransducerTypeFinger,
    kIOHIDDigitizerTransducerTypeHand,
} IOHIDDigitizerTransducerType;

enum {
    kIOHIDDigitizerEventRange = 1u << 0,
    kIOHIDDigitizerEventTouch = 1u << 1,
    kIOHIDDigitizerEventPosition = 1u << 2,
    kIOHIDDigitizerEventIdentity = 1u << 5,
};

extern "C" {
IOHIDEventRef IOHIDEventCreateDigitizerEvent(
    CFAllocatorRef allocator, uint64_t timeStamp, IOHIDDigitizerTransducerType type,
    uint32_t index, uint32_t identity, uint32_t eventMask, uint32_t buttonEvent,
    IOHIDFloat x, IOHIDFloat y, IOHIDFloat z, IOHIDFloat tipPressure,
    IOHIDFloat barrelPressure, Boolean range, Boolean touch, IOOptionBits options);

IOHIDEventRef IOHIDEventCreateDigitizerFingerEvent(
    CFAllocatorRef allocator, uint64_t timeStamp, uint32_t index, uint32_t identity,
    uint32_t eventMask, IOHIDFloat x, IOHIDFloat y, IOHIDFloat z, IOHIDFloat tipPressure,
    IOHIDFloat twist, Boolean range, Boolean touch, IOOptionBits options);

void IOHIDEventAppendEvent(IOHIDEventRef parent, IOHIDEventRef child, IOOptionBits options);
void IOHIDEventSetIntegerValue(IOHIDEventRef event, uint32_t field, int value);
void IOHIDEventSetSenderID(IOHIDEventRef event, uint64_t senderID);
}

// UIKit's `_handleHIDEvent:` drops digitizer events whose senderID
// doesn't look like a real HID service. This magic constant is the
// sender id EarlGrey/KIF have used for years to make in-process
// synthetic touches pass that gate.
static const uint64_t kEnnioHIDSenderID = 0x8000000817319375ULL;

// IOHIDEventField ids for the digitizer type. Base =
// kIOHIDEventTypeDigitizer (0x0b) << 16; offsets from the
// IOHIDEventFieldDigitizer enum in IOHIDEventTypes.h.
static const uint32_t kDigitizerBase = 0x0b << 16;
static const uint32_t kFieldDigitizerRange = kDigitizerBase + 0x08;
static const uint32_t kFieldDigitizerTouch = kDigitizerBase + 0x09;
// IsDisplayIntegrated marks the digitizer as the built-in touchscreen
// so UIKit routes the touch to the key window instead of treating it
// as an external tablet. Offset 0x15 (21), NOT 0x17.
static const uint32_t kFieldDigitizerIsDisplayIntegrated = kDigitizerBase + 0x15;

@implementation EnnioHIDInjector

// Per-sequence identity. A real finger keeps a stable transducer
// index/identity from down through up; reusing them lets UIKit thread
// the moves onto the same UITouch.
static uint32_t g_eventNumber = 0;

static uint64_t nowTimestamp(void) {
    return mach_absolute_time();
}

// Build a hand+finger digitizer event and enqueue it on UIApplication.
// `mask` selects range/touch/position; `range`/`touch` are the phase
// booleans (down: 1/1, move: 1/1, up: 0/0).
static BOOL postEvent(double x, double y, uint32_t mask, Boolean range, Boolean touch) {
    __block BOOL ok = NO;
    void (^work)(void) = ^{
        UIApplication *app = UIApplication.sharedApplication;
        if (![app respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")]) return;

        uint64_t ts = nowTimestamp();
        // Parent: hand transducer, the container UIKit expects. Its
        // own touch/range integer fields must be set explicitly (the
        // creator args alone don't populate them on the hand event) —
        // UIKit reads them to decide the overall touch phase.
        IOHIDEventRef parent = IOHIDEventCreateDigitizerEvent(
            kCFAllocatorDefault, ts, kIOHIDDigitizerTransducerTypeHand,
            0, 0, kIOHIDDigitizerEventTouch, 0,
            (IOHIDFloat)x, (IOHIDFloat)y, 0, 0, 0, range, touch, 0);
        if (!parent) return;
        IOHIDEventSetSenderID(parent, kEnnioHIDSenderID);
        IOHIDEventSetIntegerValue(parent, kFieldDigitizerIsDisplayIntegrated, 1);
        IOHIDEventSetIntegerValue(parent, kFieldDigitizerRange, range ? 1 : 0);
        IOHIDEventSetIntegerValue(parent, kFieldDigitizerTouch, touch ? 1 : 0);

        // Child: the finger. Single-touch index 1, stable identity per
        // sequence (2 = first finger, matching UIKit's expectation).
        IOHIDEventRef finger = IOHIDEventCreateDigitizerFingerEvent(
            kCFAllocatorDefault, ts, 1, 2, mask | kIOHIDDigitizerEventIdentity,
            (IOHIDFloat)x, (IOHIDFloat)y, 0, touch ? 1.0 : 0.0, 0, range, touch, 0);
        if (!finger) { CFRelease(parent); return; }
        IOHIDEventSetIntegerValue(finger, kFieldDigitizerIsDisplayIntegrated, 1);
        IOHIDEventAppendEvent(parent, finger, 0);

        @try {
            // _handleHIDEvent: processes synchronously (the runloop
            // source's own callback); _enqueueHIDEvent: defers to the
            // next runloop turn. Env-selectable while proving the path.
            NSString *selName = getenv("ENNIO_HID_ENQUEUE") ? @"_enqueueHIDEvent:" : @"_handleHIDEvent:";
            ((void (*)(id, SEL, IOHIDEventRef))objc_msgSend)(app, NSSelectorFromString(selName), parent);
            ok = YES;
        } @catch (NSException *e) {
            ok = NO;
        }
        if (getenv("ENNIO_HID_DEBUG")) {
            NSLog(@"[enniohid] post x=%.4f y=%.4f range=%d touch=%d enqueued=%d", x, y,
                  (int)range, (int)touch, (int)ok);
        }
        CFRelease(finger);
        CFRelease(parent);
    };
    if (NSThread.isMainThread) work();
    else dispatch_sync(dispatch_get_main_queue(), work);
    return ok;
}

static const uint32_t kAllMask =
    kIOHIDDigitizerEventRange | kIOHIDDigitizerEventTouch | kIOHIDDigitizerEventPosition;

+ (BOOL)touchDownAtX:(double)x y:(double)y {
    g_eventNumber++;
    return postEvent(x, y, kAllMask, true, true);
}

+ (BOOL)touchMoveToX:(double)x y:(double)y {
    return postEvent(x, y, kAllMask, true, true);
}

+ (BOOL)touchUpAtX:(double)x y:(double)y {
    return postEvent(x, y, kAllMask, false, false);
}

@end
