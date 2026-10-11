// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: the response carries the driver version (RNEDriverVersion);
// not @MainActor, so /status answers while another route holds the main thread.

import FlyingFox
import XCTest
import os

/// Deliberately not @MainActor (unlike every other handler): it only reads a static string,
/// and a liveness probe must answer while a /viewHierarchy snapshot blocks the main thread
/// for seconds. Otherwise a merely busy runner looks dead and the re-warm kills it.
struct StatusHandler: HTTPHandler {

    /// Written into the runner app's Info.plist by scripts/build-drivers.sh (PlistBuddy).
    /// Bundle.main is the ...xctrunner app that hosts this test bundle.
    static let version: String =
        (Bundle.main.object(forInfoDictionaryKey: "RNEDriverVersion") as? String) ?? "unknown"

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> HTTPResponse {
        do {
            let statusResponse = StatusResponse(status: "ok", version: Self.version)
            let responseBody = try JSONEncoder().encode(statusResponse)
            return HTTPResponse(statusCode: .ok, headers: [.contentType: "application/json"], body: responseBody)
        } catch let error {
            return AppError(message: "Error in passing status \(error.localizedDescription)").httpResponse
        }
    }
}
