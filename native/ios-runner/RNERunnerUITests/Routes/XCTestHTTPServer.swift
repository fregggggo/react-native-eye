// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: route table trimmed to the react-native-eye API; default port 7310;
// POSTs must say Content-Type: application/json (JSONContentTypeGuard).

import FlyingFox
import Foundation

enum Route: String, CaseIterable {
    case status
    case viewHierarchy
    case touch
    case swipe
    case inputText
    case eraseText
    case pressKey
    case pressButton
    case screenshot
    case isScreenStatic
    case deviceInfo

    func toHTTPRoute() -> HTTPRoute {
        return HTTPRoute(rawValue)
    }
}

struct XCTestHTTPServer {
    /// Used only when neither SIMCTL_CHILD_PORT (simctl launch) nor TEST_RUNNER_PORT
    /// (xcodebuild test-without-building) provided PORT.
    static let defaultPort: UInt16 = 7310

    func start() async throws {
        let port = ProcessInfo.processInfo.environment["PORT"]?.toUInt16() ?? Self.defaultPort
        let server = HTTPServer(address: try .inet(ip4: "127.0.0.1", port: port), timeout: 100)

        for route in Route.allCases {
            let handler = await RouteHandlerFactory.createRouteHandler(route: route)
            await server.appendRoute(route.toHTTPRoute(), to: JSONContentTypeGuard(inner: handler))
        }

        NSLog("react-native-eye runner \(StatusHandler.version) listening on 127.0.0.1:\(port)")
        try await server.run()
    }
}

/// Refuses a POST whose Content-Type is not application/json (415, nothing performed).
/// A web page in the host's browser can send a "simple" cross-origin POST to 127.0.0.1
/// (text/plain, no preflight) and the handlers would decode it as JSON anyway; requiring
/// application/json forces a CORS preflight, which this server never answers.
struct JSONContentTypeGuard: HTTPHandler {
    let inner: any HTTPHandler

    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.method == .POST && !Self.isJSON(request.headers[.contentType]) {
            let error = AppError(
                type: .precondition,
                message: "POST requires Content-Type: application/json (got \(request.headers[.contentType] ?? "none"))"
            )
            return HTTPResponse(
                statusCode: .unsupportedMediaType,
                headers: [.contentType: "application/json"],
                body: (try? JSONEncoder().encode(error)) ?? Data()
            )
        }
        return try await inner.handleRequest(request)
    }

    /// `application/json`, optionally with parameters (`; charset=utf-8`), any case.
    static func isJSON(_ value: String?) -> Bool {
        guard let value else { return false }
        let mediaType = value.split(separator: ";", maxSplits: 1).first ?? ""
        return mediaType.trimmingCharacters(in: .whitespaces).lowercased() == "application/json"
    }
}
