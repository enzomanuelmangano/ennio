//
//  EnnioActionsTest.swift
//  EnnioXCTestRunner
//
//  Single XCUITest entry point. The test method boots a TCP server on
//  127.0.0.1:9877 and loops reading JSON-line action commands until told to
//  quit. The test process is the helper; it stays alive across app
//  restarts (clearState etc.) so the Ennio CLI doesn't have to reboot
//  XCTest between flows. Cold start (~10-15s) is paid once.
//

import XCTest

final class EnnioActionsTest: XCTestCase {
    override class var defaultTestSuite: XCTestSuite {
        // Expose a single test method so xcodebuild can invoke it via
        //   -only-testing:EnnioXCTestRunner/EnnioActionsTest/test_runActionServer
        let suite = XCTestSuite(name: "EnnioActionsTest")
        suite.addTest(EnnioActionsTest(selector: #selector(test_runActionServer)))
        return suite
    }

    func test_runActionServer() {
        // XCUI's recordFailure can mark the test failed but the method keeps
        // running so the helper TCP server stays alive across many flows.
        continueAfterFailure = true
        // The CLI sets ENNIO_BUNDLE_ID / ENNIO_XCTEST_PORT on the booted
        // simulator's launchd before spawning xcodebuild. testmanagerd does
        // not forward host shell env to the runner app, but apps launched
        // on the sim DO inherit launchd env, so this reaches us here.
        let port = ProcessInfo.processInfo.environment["ENNIO_XCTEST_PORT"]
            .flatMap { Int($0) } ?? 9877

        let bundleId = ProcessInfo.processInfo.environment["ENNIO_BUNDLE_ID"]
            ?? "com.ennio.example"

        let app = XCUIApplication(bundleIdentifier: bundleId)
        // We don't launch here. The Ennio CLI launches the app via simctl.
        // We just attach to whatever's running for queries / coordinates.

        let server = ActionServer(app: app, port: port)
        do {
            try server.start()
        } catch {
            XCTFail("ActionServer failed to start on port \(port): \(error)")
            return
        }

        // Block this test method until ActionServer signals quit. Without
        // this, XCTest treats the method as finished and tears down the
        // testmanagerd connection, killing XCUI access.
        server.waitUntilQuit()
    }
}
