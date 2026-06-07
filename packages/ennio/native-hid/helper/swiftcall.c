/*
 * swiftcall.c — ABI trampoline for calling a Swift instance method
 * from C/Swift via its raw dispatch-thunk pointer.
 *
 * Swift's arm64 ABI passes `self` in the dedicated swiftself register
 * x20, not as a normal argument. SimDeviceLegacyHIDClient.send(message:)
 * is a non-@objc Swift method, so there's no selector to go through —
 * we resolve the thunk by symbol and call it with self placed in x20.
 *
 * ennio_swift_send(msg, selfObj, thunk):
 *   x0 = msg (already the first arg of send(message:)) — preserved
 *   x1 = selfObj → moved into x20 (swiftself)
 *   x2 = thunk   → tail-branch
 */

#if defined(__aarch64__)
__attribute__((naked)) void ennio_swift_send(void *msg, void *selfObj, void *thunk) {
  __asm__ volatile(
      "mov x20, x1\n\t"
      "br  x2\n\t");
}
#else
#error "enniohid host helper targets arm64 simulators only"
#endif
