// enniohid spike — prove SimulatorKit.SimDeviceLegacyHIDClient.send
// lands a REAL touch (responder chain, not in-process synthesis).
//
// Build: see build.sh. Run: ./enniohid-spike <UDID> <xNorm> <yNorm>
// where xNorm/yNorm are 0..1 fractions of the screen.
//
// CoreSimulator gives us the SimDevice; SimulatorKit gives us the
// HID client + Indigo message builders. This is the same Indigo send
// idb performs, via SimulatorKit's own Swift API instead of a
// hand-built mach message.

import Foundation
import CoreGraphics

// CoreSimulator + SimulatorKit are private; loaded via -F at link time.
// Bridged through an ObjC umbrella (see enniohid-spike-Bridging.h).

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { die("usage: enniohid-spike <UDID> [xNorm yNorm]") }
let udid = args[1]
let xn = args.count > 3 ? Double(args[2]) ?? 0.5 : 0.5
let yn = args.count > 3 ? Double(args[3]) ?? 0.5 : 0.5

// 1. Resolve the SimDevice via CoreSimulator.
guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
    die("SimServiceContext class not found — CoreSimulator not linked")
}
let devDir = (try? shell("xcode-select", ["-p"])) ?? "/Applications/Xcode.app/Contents/Developer"
let ctxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
guard ctxClass.responds(to: ctxSel) else { die("no sharedServiceContextForDeveloperDir:error:") }

typealias CtxFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let ctxImp = unsafeBitCast(ctxClass.method(for: ctxSel), to: CtxFn.self)
var err: NSError?
guard let ctx = ctxImp(ctxClass, ctxSel, devDir as NSString, &err) else {
    die("serviceContext failed: \(String(describing: err))")
}

let setSel = NSSelectorFromString("defaultDeviceSetWithError:")
typealias SetFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let setImp = unsafeBitCast((ctx as! NSObject).method(for: setSel), to: SetFn.self)
guard let deviceSet = setImp(ctx, setSel, &err) else {
    die("deviceSet failed: \(String(describing: err))")
}

// devicesByUDID -> [NSUUID: SimDevice]
let byUDID = (deviceSet as AnyObject).value(forKey: "devicesByUDID") as? [NSObject: AnyObject] ?? [:]
var device: AnyObject?
for (k, v) in byUDID {
    if (k.value(forKey: "UUIDString") as? String)?.uppercased() == udid.uppercased() {
        device = v; break
    }
}
guard let dev = device else { die("device \(udid) not found (\(byUDID.count) devices)") }
let state = (dev.value(forKey: "state") as? Int) ?? -1
FileHandle.standardError.write("device found, state=\(state) (3=booted)\n".data(using: .utf8)!)

// 2. SimDeviceLegacyHIDClient(device:)
guard let hidClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") as? NSObject.Type
        ?? NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") as? NSObject.Type else {
    die("SimDeviceLegacyHIDClient class not found")
}
let initSel = NSSelectorFromString("initWithDevice:error:")
let hidObj = hidClass.alloc()
typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> AnyObject?
let initImp = unsafeBitCast(hidObj.method(for: initSel), to: InitFn.self)
guard let hid = initImp(hidObj, initSel, dev, &err) else {
    die("HID client init failed: \(String(describing: err))")
}
FileHandle.standardError.write("HID client ready\n".data(using: .utf8)!)

// 3. Build + send a digitizer Down then Up via the C bridge.
//    enniohid_send_touch is implemented in indigo_bridge.m — it calls
//    IndigoHIDMessageForPointerEventFromHIDEventRef + the client's
//    send(message:freeWhenDone:...). See bridge for the exact path.
let ok = enniohid_send_touch(hid, xn, yn)
FileHandle.standardError.write("send_touch returned \(ok)\n".data(using: .utf8)!)
exit(ok ? 0 : 2)

func shell(_ cmd: String, _ a: [String]) throws -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = [cmd] + a
    let pipe = Pipe(); p.standardOutput = pipe
    try p.run(); p.waitUntilExit()
    let d = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}
