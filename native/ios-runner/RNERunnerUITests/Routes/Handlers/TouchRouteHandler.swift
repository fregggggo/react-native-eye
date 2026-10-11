// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: durationMs (milliseconds) instead of duration (seconds);
// a missing private XCTest symbol answers 501 unsupported.

import FlyingFox
import XCTest
import os

@MainActor
struct TouchRouteHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let decoder = JSONDecoder()

        guard let requestBody = try? await decoder.decode(TouchRequest.self, from: request.bodyData) else {
            NSLog("Invalid request for tapping")
            return AppError(type: .precondition, message: "incorrect request body provided for tap route").httpResponse
        }
        if let durationMs = requestBody.durationMs, durationMs < 0 {
            return AppError(type: .precondition, message: "touch durationMs can not be negative").httpResponse
        }

        let (width, height) = ScreenSizeHelper.physicalScreenSize()
        let point = ScreenSizeHelper.orientationAwarePoint(
            width: width,
            height: height,
            point: CGPoint(x: CGFloat(requestBody.x), y: CGFloat(requestBody.y))
        )
        let (x, y) = (point.x, point.y)

        if let seconds = requestBody.durationSeconds {
            NSLog("Long pressing \(x), \(y) for \(seconds)s")
        } else {
            NSLog("Tapping \(x), \(y)")
        }

        do {
            let eventRecord = try EventRecord(orientation: ScreenSizeHelper.currentInterfaceOrientation())
            _ = try eventRecord.addPointerTouchEvent(
                at: CGPoint(x: CGFloat(x), y: CGFloat(y)),
                touchUpAfter: requestBody.durationSeconds
            )
            let start = Date()
            try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)
            let duration = Date().timeIntervalSince(start)
            NSLog("Tapping took \(duration)")
            return HTTPResponse(statusCode: .ok)
        } catch let error as AppError {
            return error.httpResponse
        } catch {
            NSLog("Error tapping: \(error)")
            return AppError(message: "Error tapping point: \(error.localizedDescription)").httpResponse
        }
    }
}
