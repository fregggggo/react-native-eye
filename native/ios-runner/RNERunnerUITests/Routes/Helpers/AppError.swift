// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: added the `unsupported` error type (HTTP 501) and AppError.unsupported(_:).

import Foundation
import FlyingFox

enum AppErrorType: String, Codable {
    case `internal`
    case precondition
    case timeout
    /// A private XCTest class or selector the runner relies on does not exist in this
    /// Xcode / iOS runtime. Nothing was performed; the client falls back to another path.
    case unsupported
}

struct AppError: Error, Codable {
    let type: AppErrorType
    let message: String

    private var statusCode: HTTPStatusCode {
        switch type {
        case .internal: return .internalServerError
        case .precondition: return .badRequest
        case .timeout: return .requestTimeout
        case .unsupported: return .notImplemented
        }
    }

    var httpResponse: HTTPResponse {
        let body = try? JSONEncoder().encode(self)
        return HTTPResponse(statusCode: statusCode, body: body ?? Data())
    }

    init(type: AppErrorType = .internal, message: String) {
        self.type = type
        self.message = message
    }

    /// 501 `{"code":"unsupported","errorMessage":"<symbol>"}` — `symbol` names the missing
    /// private class or selector, e.g. `XCPointerEventPath` or `-[XCPointerEventPath initForTextInput]`.
    static func unsupported(_ symbol: String) -> AppError {
        AppError(type: .unsupported, message: symbol)
    }

    private enum CodingKeys : String, CodingKey {
        case type = "code"
        case message = "errorMessage"
    }
}

extension NSError {
    /// True when this is one of the two XCUITest "the app never reached idle" timeouts: a UI-query
    /// evaluation timeout (`XCTFuture` / 1000) or a main-thread-busy failure (`automation-support` / 6).
    /// Both are deterministic, device-answered failures, so route handlers classify them as `.timeout`
    /// (HTTP 408 -> non-retryable TEST_ERROR with the real message) rather than a bare 500 the worker
    /// relabels "Unknown error" and retries. Centralized here so a future Apple domain/code change is a
    /// one-line update; every handler that surfaces this timeout must go through this property.
    var isXCUITestTimeout: Bool {
        (domain == "com.apple.dt.XCTest.XCTFuture"
            && code == 1000
            && localizedDescription.contains("Timed out while evaluating UI query"))
        || (domain == "com.apple.dt.xctest.automation-support.error"
            && code == 6
            && localizedDescription.contains("Unable to perform work on main run loop, process main thread busy for"))
    }
}
