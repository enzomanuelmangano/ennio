/*
 * indigo_touch.h — Indigo HID wire format + touch-message builder.
 *
 * The struct layout and the touch builder algorithm are vendored from
 * Meta's FBSimulatorControl (MIT-licensed): PrivateHeaders/SimulatorApp/
 * {Indigo.h,Mach.h} and FBSimulatorControl/HID/FBSimulatorIndigoHID.m.
 * Copyright (c) Meta Platforms, Inc. and affiliates — MIT. Vendored so
 * ennio's in-house HID needs only this ~1 struct + builder + the
 * already-exported SimulatorKit C entry point
 * IndigoHIDMessageForMouseNSEvent — not the wider FBSimulatorControl
 * framework.
 *
 * A touch message is built by reshaping the base message that
 * IndigoHIDMessageForMouseNSEvent produces into the 2-payload digitizer
 * form SimHIDVirtualServiceManager expects.
 */

#ifndef ENNIO_INDIGO_TOUCH_H
#define ENNIO_INDIGO_TOUCH_H

#include <CoreGraphics/CoreGraphics.h>
#include <stddef.h>

#pragma pack(push, 4)

typedef struct {
  unsigned int msgh_bits;
  unsigned int msgh_size;
  unsigned int msgh_remote_port;
  unsigned int msgh_local_port;
  unsigned int msgh_voucher_port;
  int msgh_id;
} MachMessageHeader;

typedef struct {
  unsigned int field1;
  unsigned int field2;
  unsigned int field3;
  double xRatio;
  double yRatio;
  double field6;
  double field7;
  double field8;
  unsigned int field9;
  unsigned int field10;
  unsigned int field11;
  unsigned int field12;
  unsigned int field13;
  double field14;
  double field15;
  double field16;
  double field17;
  double field18;
} IndigoTouch;

typedef struct {
  unsigned int eventSource;
  unsigned int eventType;
  unsigned int eventTarget;
  unsigned int keyCode;
  unsigned int field5;
} IndigoButton;

/* The union is 0x80 (128) bytes — sized by IndigoGameController
 * (4 IndigoQuad = 128) in the full FBSimulatorControl layout. Pinning
 * it to 128 makes sizeof(IndigoPayload)=0x90 (144) and the wire
 * messageSize 0x140 (320), matching the builder's expectation. */
typedef union {
  IndigoTouch touch;
  IndigoButton button;
  unsigned char raw[128];
} IndigoEvent;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoEvent event;
} IndigoPayload;

typedef struct {
  MachMessageHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;

#pragma pack(pop)

#define IndigoEventTypeTouch 2
#define IndigoDirectionDown 1
#define IndigoDirectionUp 2

/* SimulatorKit-exported base builder. */
extern IndigoMessage *IndigoHIDMessageForMouseNSEvent(
    CGPoint *point0, CGPoint *point1, int target, int eventType, int something);

/* arm64 ABI trampoline: call a Swift instance-method dispatch thunk
 * with `self` placed in the swiftself register (x20). See swiftcall.c. */
extern void ennio_swift_send(void *msg, void *selfObj, void *thunk);

/*
 * Build a single-finger touch message at the normalized ratio
 * (0..1, top-left origin). `direction` is IndigoDirectionDown/Up.
 * Returns a calloc'd IndigoMessage (caller frees); sizeOut gets the
 * wire size. Mirrors FBSimulatorIndigoHID touchMessageWithPoint +
 * touchMessageWithPayload exactly.
 */
static inline IndigoMessage *ennio_indigo_touch(double xRatio, double yRatio,
                                                int direction, size_t *sizeOut) {
  CGPoint point = CGPointMake(xRatio, yRatio);
  IndigoMessage *base = IndigoHIDMessageForMouseNSEvent(&point, NULL, 0x32, direction, 0);
  if (!base) return NULL;
  base->payload.event.touch.xRatio = point.x;
  base->payload.event.touch.yRatio = point.y;

  size_t messageSize = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  size_t stride = sizeof(IndigoPayload);
  if (sizeOut) *sizeOut = messageSize;

  IndigoMessage *message = (IndigoMessage *)calloc(1, messageSize);
  message->innerSize = sizeof(IndigoPayload);
  message->eventType = IndigoEventTypeTouch;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = base->payload.timestamp;

  /* Copy the digitizer payload built by the base call. */
  memcpy(&(message->payload.event.button), &(base->payload.event.touch), sizeof(IndigoTouch));

  /* Duplicate the payload at +stride and tag the second slot. */
  unsigned char *dst = (unsigned char *)&(message->payload) + stride;
  memcpy(dst, &(message->payload), stride);
  IndigoPayload *second = (IndigoPayload *)dst;
  second->event.touch.field1 = 0x00000001;
  second->event.touch.field2 = 0x00000002;

  free(base);
  return message;
}

#endif /* ENNIO_INDIGO_TOUCH_H */
