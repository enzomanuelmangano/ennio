//
// EnnioDriverUITests.swift
//
// XCTest companion runner for ennio. Spawned at session start via
// `xcodebuild test-without-building` (or pre-built xctest bundle).
// The single test function below stays alive for the duration of the
// session, running a HTTP server on EnnioDriverPort. ennio's CLI
// posts requests like:
//
//   POST /tap_label  { "bundleId": "xyz...", "label": "Go back" }
//
// ...and the test handler uses XCUIApplication(bundleIdentifier:).
// .descendants(matching:.any).matching(identifier:|label:).firstMatch
// .tap() to activate via XCTest's privileged HID path. That path
// goes through accessibilityd as a system AX event, which the host
// app's gesture-recogniser trusts unconditionally — succeeding
// where our in-process synthesized HID touch fails (Bluesky's
// React-Navigation back-arrow).
//
// Only used as a fallback. ennio still does find + tap in-process
// via dylib; the driver is invoked only when a tap was needed but
// no progress was observed.
//

import XCTest
import Foundation

let EnnioDriverPort: UInt16 = 9088

final class EnnioDriverUITests: XCTestCase {
    func testRunUntilShutdown() {
        let server = EnnioDriverServer()
        server.start()
        // Park the test for the lifetime of the simulator session.
        // XCTest reaps the runner when the parent process exits, so
        // we don't need explicit shutdown plumbing.
        RunLoop.main.run()
    }
}

/// Minimal HTTP server. One worker per accept; no thread pool — the
/// ennio CLI fires one request at a time during the few flow steps
/// that need driver assistance.
final class EnnioDriverServer {
    private var socketDescriptor: Int32 = -1

    func start() {
        socketDescriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else {
            NSLog("[ennio-driver] socket() failed")
            return
        }
        var reuse: Int32 = 1
        setsockopt(socketDescriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse)))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(EnnioDriverPort).bigEndian
        addr.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            NSLog("[ennio-driver] bind() failed: \(String(cString: strerror(errno)))")
            return
        }
        guard listen(socketDescriptor, 8) == 0 else {
            NSLog("[ennio-driver] listen() failed")
            return
        }
        NSLog("[ennio-driver] listening on 127.0.0.1:\(EnnioDriverPort)")

        DispatchQueue.global(qos: .userInteractive).async {
            self.acceptLoop()
        }
    }

    private func acceptLoop() {
        while true {
            var clientAddr = sockaddr()
            var clientLen = socklen_t(MemoryLayout<sockaddr>.size)
            let client = accept(socketDescriptor, &clientAddr, &clientLen)
            if client < 0 { continue }
            DispatchQueue.global(qos: .userInteractive).async {
                self.handle(client)
            }
        }
    }

    private func handle(_ fd: Int32) {
        defer { close(fd) }
        var buf = [UInt8](repeating: 0, count: 8192)
        let n = read(fd, &buf, buf.count)
        guard n > 0 else { return }
        guard let raw = String(bytes: buf[0..<n], encoding: .utf8) else { return }
        // Split request line + headers + body.
        guard let bodyStart = raw.range(of: "\r\n\r\n") else { return }
        let head = String(raw[..<bodyStart.lowerBound])
        let body = String(raw[bodyStart.upperBound...])
        let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else { return }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return }
        let path = String(parts[1])

        let (status, response) = route(path: path, body: body)
        let httpResponse =
            "HTTP/1.1 \(status) OK\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: \(response.utf8.count)\r\n" +
            "Connection: close\r\n\r\n" +
            response
        let bytes = Array(httpResponse.utf8)
        _ = bytes.withUnsafeBufferPointer { ptr in
            write(fd, ptr.baseAddress, ptr.count)
        }
    }

    private func route(path: String, body: String) -> (Int, String) {
        switch path {
        case "/ping":
            return (200, "{\"ok\":true}")
        case "/tap_label":
            return tapLabel(body: body)
        case "/tap_identifier":
            return tapIdentifier(body: body)
        default:
            return (404, "{\"ok\":false,\"err\":\"unknown route\"}")
        }
    }

    /// Tap the first element whose accessibility label matches.
    /// Body: { "bundleId": "xyz.foo", "label": "Go back" }
    private func tapLabel(body: String) -> (Int, String) {
        guard
            let data = body.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let bundleId = json["bundleId"] as? String,
            let label = json["label"] as? String
        else {
            return (400, "{\"ok\":false,\"err\":\"bad payload\"}")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        // XCUIElementQuery: descendants(matching:.any) then label match.
        // XCTest's tap() routes through accessibilityd's AX activate —
        // the path that bypasses synthesized-HID gesture-recogniser
        // misses for Bluesky's nav-header back arrow.
        let predicate = NSPredicate(format: "label == %@", label)
        let el = app.descendants(matching: .any).matching(predicate).firstMatch
        if !el.waitForExistence(timeout: 3) {
            return (404, "{\"ok\":false,\"err\":\"label not found\"}")
        }
        el.tap()
        return (200, "{\"ok\":true}")
    }

    /// Tap by accessibility identifier (RN testID).
    private func tapIdentifier(body: String) -> (Int, String) {
        guard
            let data = body.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let bundleId = json["bundleId"] as? String,
            let identifier = json["identifier"] as? String
        else {
            return (400, "{\"ok\":false,\"err\":\"bad payload\"}")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        let el = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        if !el.waitForExistence(timeout: 3) {
            return (404, "{\"ok\":false,\"err\":\"identifier not found\"}")
        }
        el.tap()
        return (200, "{\"ok\":true}")
    }
}
