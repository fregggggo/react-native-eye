// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: Maestro's SwipeRouteHandlerV2 served as /swipe; durationMs in the
// request (see SwipeRequest); a missing private XCTest symbol answers 501 unsupported.

import FlyingFox
import XCTest
import os

@MainActor
struct SwipeRouteHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(SwipeRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body provided for swipe request").httpResponse
        }

        if (requestBody.duration < 0) {
            return AppError(type: .precondition, message: "swipe durationMs can not be negative").httpResponse
        }

        do {
            try await swipePrivateAPI(requestBody)
            return HTTPResponse(statusCode: .ok)
        } catch let error {
            return Self.classify(error).httpResponse
        }
    }

    /// Maps a swipe failure to an `AppError`: an AppError (e.g. unsupported) passes through;
    /// an XCUITest timeout (see `NSError.isXCUITestTimeout`) becomes `.timeout` (HTTP 408);
    /// any other error keeps the default 500.
    nonisolated static func classify(_ error: Error) -> AppError {
        if let appError = error as? AppError {
            return appError
        }
        let message = "Swipe request failure. Error: \(error.localizedDescription)"
        if (error as NSError).isXCUITestTimeout {
            return AppError(type: .timeout, message: message)
        }
        return AppError(message: message)
    }

    func swipePrivateAPI(_ request: SwipeRequest) async throws {
        let (width, height) = ScreenSizeHelper.physicalScreenSize()
        let startPoint = ScreenSizeHelper.orientationAwarePoint(
            width: width,
            height: height,
            point: request.start
        )
        let endPoint = ScreenSizeHelper.orientationAwarePoint(
            width: width,
            height: height,
            point: request.end
        )

        let description = "Swipe from \(request.start) to \(request.end) with \(request.duration)s duration"
        logger.info("\(description)")

        let eventTarget = try EventTarget()
        try await eventTarget.dispatchEvent(description: description) {
            try EventRecord(orientation: ScreenSizeHelper.currentInterfaceOrientation())
                .addSwipeEvent(
                    start: startPoint,
                    end: endPoint,
                    duration: request.duration
                )
        }
    }
}
