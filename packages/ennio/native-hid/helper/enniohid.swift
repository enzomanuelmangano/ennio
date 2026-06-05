// enniohid — in-house host-side HID sender. Posts real touches into
// the simulator via CoreSimulator Indigo: builds a digitizer Indigo
// message (struct + builder vendored MIT from Meta's FBSimulatorControl,
// see indigo_touch.h) and sends it through SimulatorKit's
// SimDeviceLegacyHIDClient. No external daemon.
//
// Spike form: posts a single Down→Up at a normalized point to prove
// the seam end to end. Becomes a persistent stdin-driven process once
// proven.
//
// Usage: enniohid <UDID> <xNorm> <yNorm>

import Foundation

import Darwin
import ObjectiveC

func die(_ m: String) -> Never {
    FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1)
}

let argv = CommandLine.arguments
guard argv.count >= 2 else { die("usage: enniohid <UDID>  (then newline cmds on stdin)") }
let udid = argv[1]

// ── 1. Resolve the SimDevice via CoreSimulator (ObjC runtime) ───────
guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
    die("SimServiceContext not found")
}
let devDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
    ?? "/Applications/Xcode.app/Contents/Developer"
var err: NSError?
let ctxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
typealias CtxFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let ctx = unsafeBitCast(ctxClass.method(for: ctxSel), to: CtxFn.self)(
    ctxClass, ctxSel, devDir as NSString, &err)
guard let ctx else { die("serviceContext: \(String(describing: err))") }

let setSel = NSSelectorFromString("defaultDeviceSetWithError:")
typealias SetFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let deviceSet = unsafeBitCast((ctx as! NSObject).method(for: setSel), to: SetFn.self)(ctx, setSel, &err)
guard let deviceSet else { die("deviceSet: \(String(describing: err))") }

let byUDID = (deviceSet as AnyObject).value(forKey: "devicesByUDID") as? [NSObject: AnyObject] ?? [:]
var device: AnyObject?
for (k, v) in byUDID where (k.value(forKey: "UUIDString") as? String)?.uppercased() == udid.uppercased() {
    device = v; break
}
guard let dev = device else { die("device \(udid) not found among \(byUDID.count)") }
let state = (dev.value(forKey: "state") as? Int) ?? -1
FileHandle.standardError.write("device state=\(state) (3=booted)\n".data(using: .utf8)!)

// ── 2. SimDeviceLegacyHIDClient(device:) via ObjC init ──────────────
guard let hidClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") as? NSObject.Type
        ?? NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") as? NSObject.Type else {
    die("SimDeviceLegacyHIDClient class not found")
}
let initSel = NSSelectorFromString("initWithDevice:error:")
let alloced = hidClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> AnyObject?
guard let hid = unsafeBitCast(alloced.method(for: initSel), to: InitFn.self)(alloced, initSel, dev, &err) else {
    die("HID client init: \(String(describing: err))")
}
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
log("HID client ready")

// ── 3. Build (vendored Indigo touch) + send via the ObjC-bridged
//       sendWithMessage:freeWhenDone:completionQueue:completion: ──────
// (the @objc name of SimDeviceLegacyHIDClient's send; the simple Swift
// send(message:) variant doesn't flush.)
typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
guard (hid as AnyObject).responds(to: sendSel) else { die("no sendWithMessage selector") }
let sendImp = unsafeBitCast((hid as! NSObject).method(for: sendSel), to: SendFn.self)

// direction: 1 = touch maintained (down + moves), 2 = up.
func post(_ x: Double, _ y: Double, _ direction: Int32) {
    var size: Int = 0
    guard let msg = ennio_indigo_touch(x, y, direction, &size) else { return }
    sendImp(hid, sendSel, UnsafeMutableRawPointer(msg), true, nil, nil)
}


// Keyboard key event via SimulatorKit's exported builder. dir 1=down 2=up.
func postKey(_ keyCode: Int32, _ direction: Int32) {
    guard let msg = ennio_indigo_key(keyCode, direction) else { return }
    sendImp(hid, sendSel, UnsafeMutableRawPointer(msg), true, nil, nil)
}

// ── 4. Persistent command loop. One line per command on stdin:
//        down <xNorm> <yNorm>
//        move <xNorm> <yNorm>
//        up   <xNorm> <yNorm>
//        ping
//      Coordinates are normalized [0,1], top-left origin. Each command
//      replies "ok\n" on stdout so the CLI can pipeline + await.
// ─────────────────────────────────────────────────────────────────
let out = FileHandle.standardOutput
func reply(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }
log("ready")
reply("ready")

while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ").map(String.init)
    guard let op = parts.first else { continue }
    switch op {
    case "down", "move":
        if parts.count >= 3, let x = Double(parts[1]), let y = Double(parts[2]) { post(x, y, 1) }
        reply("ok")
    case "up":
        if parts.count >= 3, let x = Double(parts[1]), let y = Double(parts[2]) { post(x, y, 2) }
        reply("ok")
    case "key":
        // key <usage> <dir>   dir 1=down 2=up
        if parts.count >= 3, let u = Int32(parts[1]), let d = Int32(parts[2]) { postKey(u, d) }
        reply("ok")
    case "ping":
        reply("ok")
    case "quit":
        reply("ok"); exit(0)
    default:
        reply("err unknown")
    }
}
exit(0)
