// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: renamed; the SwipeRouteHandlerV2 classification tests were removed
// so that the bundle contains exactly one test — the one that runs the HTTP server forever.

import XCTest
import FlyingFox
import os

final class RNERunnerUITests: XCTestCase {

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: "RNERunnerUITests"
    )

    override func setUpWithError() throws {
        // XCTest internals sometimes use XCTAssert* instead of exceptions.
        // Setting `continueAfterFailure` so that the xctest runner does not stop
        // when an XCTest internal error happes (eg: when using .allElementsBoundByIndex
        // on a ReactNative app)
        continueAfterFailure = true
    }

    override class func setUp() {
        logger.trace("setUp")
    }

    func testHttpServer() async throws {
        let server = XCTestHTTPServer()
        RNERunnerUITests.logger.info("Will start HTTP server")
        try await server.start()
    }

    override class func tearDown() {
        logger.trace("tearDown")
    }
}
