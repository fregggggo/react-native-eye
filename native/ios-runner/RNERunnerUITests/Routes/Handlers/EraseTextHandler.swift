// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: request has no appIds; a missing private XCTest symbol answers 501.

import Foundation
import FlyingFox
import os
import XCTest

@MainActor
struct EraseTextHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(EraseTextRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for erase text request").httpResponse
        }
        guard requestBody.charactersToErase >= 0 else {
            return AppError(type: .precondition, message: "charactersToErase can not be negative").httpResponse
        }
        if requestBody.charactersToErase == 0 {
            return HTTPResponse(statusCode: .ok)
        }

        do {
            let start = Date()

            await TextInputHelper.waitUntilKeyboardIsPresented()

            let deleteText = String(repeating: XCUIKeyboardKey.delete.rawValue, count: requestBody.charactersToErase)

            try await TextInputHelper.inputText(deleteText)

            let duration = Date().timeIntervalSince(start)
            logger.info("Erase text duration took \(duration)")
            return HTTPResponse(statusCode: .ok)
        } catch let error as AppError {
            return error.httpResponse
        } catch let error {
            logger.error("Error erasing text of \(requestBody.charactersToErase) characters: \(error)")
            return AppError(message: "Failure in doing erase text, error: \(error.localizedDescription)").httpResponse
        }
    }

}
