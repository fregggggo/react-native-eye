// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: PNG only (the `compressed` JPEG query option was dropped).

import FlyingFox
import XCTest
import os

@MainActor
struct ScreenshotHandler: HTTPHandler {
    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        guard !png.isEmpty else {
            return AppError(message: "screenshot produced no PNG data").httpResponse
        }
        return HTTPResponse(statusCode: .ok, headers: [.contentType: "image/png"], body: png)
    }
}
