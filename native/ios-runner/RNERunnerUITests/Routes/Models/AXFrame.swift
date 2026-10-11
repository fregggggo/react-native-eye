// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: moved from the MaestroDriverLib framework into the UI-test target.

import Foundation

/// A dictionary representing frame coordinates with keys: "X", "Y", "Width", "Height"
public typealias AXFrame = [String: Double]

extension AXFrame {
    public static var zero: Self {
        ["X": 0, "Y": 0, "Width": 0, "Height": 0]
    }

    public var x: Double { self["X"] ?? 0 }
    public var y: Double { self["Y"] ?? 0 }
    public var width: Double { self["Width"] ?? 0 }
    public var height: Double { self["Height"] ?? 0 }

    public var centerX: Double { x + width / 2 }
    public var centerY: Double { y + height / 2 }
}
