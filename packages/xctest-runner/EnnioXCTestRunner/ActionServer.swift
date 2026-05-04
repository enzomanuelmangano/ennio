//
//  ActionServer.swift
//  EnnioXCTestRunner
//
//  TCP server. JSON-line protocol. One request per line, one response per line.
//
//  Request shape:
//      { "id": "<correlation>", "type": "<command>", "payload": { ... } }
//
//  Response shape:
//      { "id": "<correlation>", "ok": true,  "data": { ... } }
//      { "id": "<correlation>", "ok": false, "error": "<message>" }
//
//  All coordinates are normalized 0..1 fractions of the simulator screen.
//  The CLI converts Fabric layout (in React surface coords) -> normalized
//  screen coords using getScreenSize, so the helper never needs to know
//  about safe-area insets.
//

import Foundation
import Network
import XCTest

final class ActionServer {
    private let app: XCUIApplication
    private let port: Int
    private var listener: NWListener?
    private let quitSemaphore = DispatchSemaphore(value: 0)
    private let queue = DispatchQueue(label: "ennio.xctest.actionserver")

    init(app: XCUIApplication, port: Int) {
        self.app = app
        self.port = port
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Bind explicitly to IPv4 loopback. NWListener with the default
        // wildcard endpoint can land on an IPv6-only socket on macOS, which
        // refuses IPv4 connect() even from 127.0.0.1.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(integerLiteral: UInt16(port))
        )
        let listener = try NWListener(using: params)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        listener.stateUpdateHandler = { state in
            NSLog("[Ennio XCTest] listener state: \(state)")
        }
        listener.start(queue: queue)
        NSLog("[Ennio XCTest] ActionServer listening on 127.0.0.1:\(port)")
    }

    func waitUntilQuit() {
        // Drive the main runloop so XCUI APIs (which must run on main) can
        // execute. Blocking the main thread on a semaphore deadlocks because
        // dispatch_async to main never gets scheduled.
        var quit = false
        DispatchQueue.global().async { [self] in
            quitSemaphore.wait()
            DispatchQueue.main.async { quit = true; CFRunLoopStop(CFRunLoopGetMain()) }
        }
        while !quit {
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
        }
        listener?.cancel()
        NSLog("[Ennio XCTest] quit signaled")
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: queue)
        receiveLine(on: connection, buffer: Data())
    }

    private func receiveLine(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                NSLog("[Ennio XCTest] recv error: \(error)")
                connection.cancel()
                return
            }
            var combined = buffer
            if let data { combined.append(data) }

            while let newlineRange = combined.firstRange(of: Data([0x0A])) {
                let lineData = combined.subdata(in: 0..<newlineRange.lowerBound)
                combined.removeSubrange(0..<newlineRange.upperBound)
                self.processLine(lineData, connection: connection)
            }

            if isComplete {
                connection.cancel()
                return
            }
            self.receiveLine(on: connection, buffer: combined)
        }
    }

    private func processLine(_ data: Data, connection: NWConnection) {
        guard !data.isEmpty else { return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendError(id: "", error: "invalid JSON", connection: connection)
            return
        }
        let id = json["id"] as? String ?? ""
        let type = json["type"] as? String ?? ""
        let payload = json["payload"] as? [String: Any] ?? [:]

        // XCUI APIs (XCUIApplication.activate, XCUIElement.tap, typeText, etc.)
        // assert main thread. Dispatch here, block this background queue
        // until the main-thread call returns, then respond.
        var capturedResult: [String: Any] = [:]
        var capturedError: String?
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            do {
                capturedResult = try self.dispatch(type: type, payload: payload)
            } catch {
                capturedError = "\(error)"
            }
            sem.signal()
        }
        sem.wait()

        if let err = capturedError {
            sendError(id: id, error: err, connection: connection)
        } else {
            sendOK(id: id, data: capturedResult, connection: connection)
        }

        if type == "quit" {
            connection.cancel()
            quitSemaphore.signal()
        }
    }

    // MARK: - Command dispatch

    private func dispatch(type: String, payload: [String: Any]) throws -> [String: Any] {
        // For any HID action, make sure the user's app is the foreground
        // window. XCUITest opens its own runner app on top by default, so
        // without activate() the synthesized tap lands on the runner.
        switch type {
        case "tap", "doubleTap", "longPress", "swipe", "typeText", "pressKey",
             "clearText", "tapAlertButton", "dismissAlert", "paste",
             "back", "findByLabel", "findById", "tapById":
            app.activate()
        default: break
        }

        switch type {
        case "ping":
            return ["pong": true]

        case "getScreenSize":
            let screen = XCUIScreen.main
            let size = screen.screenshot().image.size
            // Top inset = height of the user app's first window minus its
            // safe-area frame. On modern iPhones (notch / Dynamic Island)
            // XCUI's status bar element is often hidden, so we measure the
            // window directly. If everything reports zero (uncommon), fall
            // back to 59pt (modern iPhone Pro constant) so taps that
            // resolve via Fabric layout still hit the right pixel.
            var safeTop: Double = 0
            app.activate()
            let window = app.windows.firstMatch
            if window.exists {
                let wf = window.frame
                safeTop = Double(wf.minY)
                // wf.minY can be 0 on edge-to-edge apps. Use the status
                // bar element if present.
                if safeTop == 0 {
                    let sb = app.statusBars.firstMatch
                    if sb.exists { safeTop = Double(sb.frame.height) }
                }
            }
            if safeTop == 0 { safeTop = 59 }
            return [
                "width": size.width,
                "height": size.height,
                "safeAreaTop": safeTop,
                "safeAreaBottom": 34.0,
            ]

        case "tap":
            let (x, y) = try normalizedPoint(payload)
            coordinate(x: x, y: y).tap()
            return [:]

        case "doubleTap":
            let (x, y) = try normalizedPoint(payload)
            coordinate(x: x, y: y).doubleTap()
            return [:]

        case "longPress":
            let (x, y) = try normalizedPoint(payload)
            let ms = (payload["ms"] as? Double) ?? 500
            coordinate(x: x, y: y).press(forDuration: TimeInterval(ms / 1000.0))
            return [:]

        case "swipe":
            let fromX = try requireDouble(payload, "fromX")
            let fromY = try requireDouble(payload, "fromY")
            let toX = try requireDouble(payload, "toX")
            let toY = try requireDouble(payload, "toY")
            let ms = (payload["ms"] as? Double) ?? 300
            let from = coordinate(x: fromX, y: fromY)
            let to = coordinate(x: toX, y: toY)
            from.press(forDuration: TimeInterval(ms / 1000.0), thenDragTo: to)
            return [:]

        case "typeText":
            guard let text = payload["text"] as? String else {
                throw ActionError.badPayload("typeText: missing text")
            }
            try requireKeyboardFocus()
            app.typeText(text)
            return [:]

        case "pressKey":
            guard let name = payload["name"] as? String else {
                throw ActionError.badPayload("pressKey: missing name")
            }
            try requireKeyboardFocus()
            try pressKey(name)
            return [:]

        case "clearText":
            try requireKeyboardFocus()
            app.typeText(String(XCUIKeyboardKey.delete.rawValue))
            return [:]

        case "findByLabel":
            guard let text = payload["text"] as? String else {
                throw ActionError.badPayload("findByLabel: missing text")
            }
            let exact = (payload["exact"] as? Bool) ?? false
            // Try tab-bar buttons first - the iOS native UITabBar items are
            // the most common text-only target in flows ("Home" / "Settings"
            // / etc.) and a generic descendants query can match the wrong
            // text node further up the tree.
            let exactPred = NSPredicate(format: "label == %@", text)
            let containsPred = NSPredicate(format: "label CONTAINS %@", text)
            let pred = exact ? exactPred : containsPred
            let queries: [XCUIElementQuery] = [
                app.tabBars.buttons.matching(exactPred),
                app.tabBars.buttons.matching(pred),
                app.buttons.matching(pred),
                app.staticTexts.matching(pred),
                app.descendants(matching: .any).matching(pred),
            ]
            var found: XCUIElement? = nil
            for q in queries {
                let candidate = q.firstMatch
                if candidate.exists {
                    found = candidate
                    break
                }
            }
            guard let element = found else { return ["found": false] }
            let frame = element.frame
            return [
                "found": true,
                "frame": [
                    "x": frame.origin.x,
                    "y": frame.origin.y,
                    "width": frame.size.width,
                    "height": frame.size.height,
                ],
            ]

        case "tapById":
            // Direct XCUIElement.tap on a matched accessibility identifier.
            // Uses XCUI's own hit-point resolution (the element's
            // hittablePoint), which handles wrapper-vs-content frame
            // mismatches RN produces around TextInputs and the like.
            guard let id = payload["id"] as? String else {
                throw ActionError.badPayload("tapById: missing id")
            }
            let queries: [XCUIElementQuery] = [
                app.textFields.matching(identifier: id),
                app.secureTextFields.matching(identifier: id),
                app.buttons.matching(identifier: id),
                app.links.matching(identifier: id),
                app.switches.matching(identifier: id),
                app.descendants(matching: .any).matching(identifier: id),
            ]
            var hit: XCUIElement? = nil
            for q in queries {
                let candidate = q.firstMatch
                if candidate.exists {
                    hit = candidate
                    break
                }
            }
            guard let el = hit else { throw ActionError.notFound("tapById: \(id)") }
            el.tap()
            return [:]

        case "findById":
            // Accessibility identifier matches RN's testID. XCUI returns
            // absolute window-relative frames, which sidesteps Fabric's
            // navigator-relative screenY ambiguity.
            //
            // RN often replicates the same identifier across both a parent
            // wrapper view AND the inner interactive element (TextField,
            // Button, etc.). The wrapper's frame can extend much wider than
            // the interactive area, so a center-tap on it lands outside
            // the hit zone. Prefer interactive types first; only fall back
            // to the broad descendants query when none match.
            guard let id = payload["id"] as? String else {
                throw ActionError.badPayload("findById: missing id")
            }
            let queries: [XCUIElementQuery] = [
                app.textFields.matching(identifier: id),
                app.secureTextFields.matching(identifier: id),
                app.buttons.matching(identifier: id),
                app.links.matching(identifier: id),
                app.switches.matching(identifier: id),
                app.descendants(matching: .any).matching(identifier: id),
            ]
            var hit: XCUIElement? = nil
            for q in queries {
                let candidate = q.firstMatch
                if candidate.exists {
                    hit = candidate
                    break
                }
            }
            guard let el = hit else { return ["found": false] }
            let f = el.frame
            return [
                "found": true,
                "hittable": el.isHittable,
                "frame": [
                    "x": f.origin.x,
                    "y": f.origin.y,
                    "width": f.size.width,
                    "height": f.size.height,
                ],
            ]

        case "tapAlertButton":
            guard let title = payload["title"] as? String else {
                throw ActionError.badPayload("tapAlertButton: missing title")
            }
            let button = app.alerts.firstMatch.buttons[title]
            if !button.exists {
                throw ActionError.notFound("alert button \"\(title)\" not present")
            }
            button.tap()
            return [:]

        case "dismissAlert":
            let alert = app.alerts.firstMatch
            if !alert.exists { return ["dismissed": false] }
            // Prefer Cancel, then OK, then first button.
            for title in ["Cancel", "OK", "Dismiss"] {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return ["dismissed": true]
                }
            }
            alert.buttons.firstMatch.tap()
            return ["dismissed": true]

        case "setPasteboard":
            guard let text = payload["text"] as? String else {
                throw ActionError.badPayload("setPasteboard: missing text")
            }
            UIPasteboard.general.string = text
            return [:]

        case "getPasteboard":
            return ["text": UIPasteboard.general.string ?? ""]

        case "paste":
            let text = UIPasteboard.general.string ?? ""
            if !text.isEmpty {
                try requireKeyboardFocus()
                app.typeText(text)
            }
            return [:]

        case "back":
            // Edge swipe from left to trigger interactive nav back.
            let from = coordinate(x: 0.0, y: 0.5)
            let to = coordinate(x: 0.5, y: 0.5)
            from.press(forDuration: 0.05, thenDragTo: to)
            return [:]

        case "quit":
            return ["quit": true]

        default:
            throw ActionError.unknownCommand(type)
        }
    }

    // MARK: - Helpers

    private func coordinate(x: Double, y: Double) -> XCUICoordinate {
        let normalized = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        return normalized
    }

    private func normalizedPoint(_ payload: [String: Any]) throws -> (Double, Double) {
        let x = try requireDouble(payload, "x")
        let y = try requireDouble(payload, "y")
        return (x, y)
    }

    private func requireDouble(_ payload: [String: Any], _ key: String) throws -> Double {
        if let d = payload[key] as? Double { return d }
        if let n = payload[key] as? NSNumber { return n.doubleValue }
        throw ActionError.badPayload("missing \(key)")
    }

    private func requireKeyboardFocus() throws {
        // XCUI's typeText calls XCTestCase.recordFailure when no element has
        // keyboard focus, which fails the whole xcodebuild test run and kills
        // the helper. Pre-check by waiting briefly for the soft keyboard so
        // we can return a clean error to the client instead.
        let kb = app.keyboards.firstMatch
        if !kb.waitForExistence(timeout: 1.5) {
            throw ActionError.notFound("no keyboard focus - tap a text field first")
        }
    }

    private func pressKey(_ name: String) throws {
        let key: String
        switch name.lowercased() {
        case "enter", "return": key = "\n"
        case "tab": key = "\t"
        case "backspace", "delete": key = String(XCUIKeyboardKey.delete.rawValue)
        case "escape": key = String(XCUIKeyboardKey.escape.rawValue)
        case "space": key = " "
        case "arrow-up", "up": key = String(XCUIKeyboardKey.upArrow.rawValue)
        case "arrow-down", "down": key = String(XCUIKeyboardKey.downArrow.rawValue)
        case "arrow-left", "left": key = String(XCUIKeyboardKey.leftArrow.rawValue)
        case "arrow-right", "right": key = String(XCUIKeyboardKey.rightArrow.rawValue)
        default:
            if name.count == 1 { key = name } else {
                throw ActionError.badPayload("unsupported key: \(name)")
            }
        }
        app.typeText(key)
    }

    // MARK: - Wire I/O

    private func sendOK(id: String, data: [String: Any], connection: NWConnection) {
        send(["id": id, "ok": true, "data": data], on: connection)
    }

    private func sendError(id: String, error: String, connection: NWConnection) {
        send(["id": id, "ok": false, "error": error], on: connection)
    }

    private func send(_ obj: [String: Any], on connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var line = data
        line.append(0x0A)
        connection.send(content: line, completion: .contentProcessed { error in
            if let error { NSLog("[Ennio XCTest] send error: \(error)") }
        })
    }
}

enum ActionError: Error, CustomStringConvertible {
    case badPayload(String)
    case notFound(String)
    case unknownCommand(String)

    var description: String {
        switch self {
        case .badPayload(let s): return "bad_payload: \(s)"
        case .notFound(let s): return "not_found: \(s)"
        case .unknownCommand(let s): return "unknown_command: \(s)"
        }
    }
}
