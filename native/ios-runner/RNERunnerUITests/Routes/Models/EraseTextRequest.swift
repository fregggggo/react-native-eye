// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: appIds removed.

import Foundation

struct EraseTextRequest: Codable {
    let charactersToErase: Int
}
