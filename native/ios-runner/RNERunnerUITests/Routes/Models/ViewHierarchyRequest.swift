// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: appIds removed; the body may be {} (excludeKeyboardElements defaults to false).

import Foundation

struct ViewHierarchyRequest: Decodable {
    let excludeKeyboardElements: Bool

    enum CodingKeys: String, CodingKey {
        case excludeKeyboardElements
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        excludeKeyboardElements = try container.decodeIfPresent(Bool.self, forKey: .excludeKeyboardElements) ?? false
    }
}
