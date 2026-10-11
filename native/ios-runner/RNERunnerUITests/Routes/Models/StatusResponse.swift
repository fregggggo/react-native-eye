// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: version added.

import Foundation

struct StatusResponse: Codable {
    let status: String
    /// RNEDriverVersion from the runner's Info.plist, e.g. "0.0.1-ab12cd34"; "unknown" when absent.
    let version: String
}
