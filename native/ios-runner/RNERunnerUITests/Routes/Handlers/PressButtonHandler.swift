// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: a missing -[XCUIDevice pressLockButton] answers 501 unsupported.

import Foundation
import FlyingFox
import os
import XCTest

@MainActor
struct PressButtonHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(PressButtonRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "Incorrect request body for PressButton Handler").httpResponse
        }

        switch requestBody.button {
        case .home:
            XCUIDevice.shared.press(.home)
        case .lock:
            do {
                let selector = try PrivateAPI.selector(on: XCUIDevice.shared, "pressLockButton")
                XCUIDevice.shared.perform(selector)
            } catch let error as AppError {
                return error.httpResponse
            }
        }
        return HTTPResponse(statusCode: .ok)
    }
}
