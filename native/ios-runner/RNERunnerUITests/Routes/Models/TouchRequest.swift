// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: duration is durationMs (milliseconds) and x/y are Double.

import Foundation

struct TouchRequest : Codable {
    let x: Double
    let y: Double
    /// Hold time in milliseconds. Absent → a normal tap (0.1 s); present → long press.
    let durationMs: Double?

    /// Hold time in seconds as the XCTest event APIs expect, or nil for a normal tap.
    var durationSeconds: TimeInterval? {
        durationMs.map { $0 / 1000.0 }
    }
}
