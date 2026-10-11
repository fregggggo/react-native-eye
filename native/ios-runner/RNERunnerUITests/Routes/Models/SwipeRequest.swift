// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: appId/appIds removed; duration is durationMs (milliseconds).

import Foundation

struct SwipeRequest: Decodable {

    enum CodingKeys: String, CodingKey {
        case startX, startY, endX, endY, durationMs
    }

    let start: CGPoint
    let end: CGPoint
    /// Swipe duration in seconds (converted from the request's durationMs).
    let duration: TimeInterval

    init(start: CGPoint, end: CGPoint, duration: TimeInterval) {
        self.start = start
        self.end = end
        self.duration = duration
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        start = CGPoint(
            x: try container.decode(Double.self, forKey: .startX),
            y: try container.decode(Double.self, forKey: .startY)
        )
        end = CGPoint(
            x: try container.decode(Double.self, forKey: .endX),
            y: try container.decode(Double.self, forKey: .endY)
        )
        duration = try container.decode(Double.self, forKey: .durationMs) / 1000.0
    }
}
