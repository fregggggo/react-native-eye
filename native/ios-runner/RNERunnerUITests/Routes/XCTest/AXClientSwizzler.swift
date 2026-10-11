// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: a missing XCAXClient_iOS / -defaultParameters throws
// AppError.unsupported instead of crashing; the override is set via a throwing function.

import Foundation
import XCTest

// Use a global to pass to the swizzled implementation:
// Instance variables are not accessible after swizzling.
private var _overwriteDefaultParameters = [String: Int]()

struct AXClientSwizzler {
    fileprivate static let proxy = AXClientiOS_Standin()

    // Make this type not-initializable
    private init() {}

    static var overwriteDefaultParameters: [String: Int] {
        _overwriteDefaultParameters
    }

    /// Swizzles `-[XCAXClient_iOS defaultParameters]` on first use, then sets `key` to `value`
    /// in every snapshot request. Throws `unsupported` when the private class or method is gone.
    static func setDefaultParameter(_ key: String, _ value: Int) throws {
        if let error = setup {
            throw error
        }
        _overwriteDefaultParameters[key] = value
    }

    /// nil when the swizzle is installed; the error to report otherwise. Evaluated once.
    private static let setup: AppError? = {
        guard let axClientiOSClass: AnyClass = objc_getClass("XCAXClient_iOS") as? AnyClass else {
            return AppError.unsupported("XCAXClient_iOS")
        }
        let defaultParametersSelector = Selector(("defaultParameters"))
        guard let original = class_getInstanceMethod(axClientiOSClass, defaultParametersSelector) else {
            return AppError.unsupported("-[XCAXClient_iOS defaultParameters]")
        }
        guard let replaced = class_getInstanceMethod(
            AXClientiOS_Standin.self,
            #selector(AXClientiOS_Standin.swizzledDefaultParameters)) else {
            return AppError(message: "AXClientiOS_Standin.swizzledDefaultParameters missing")
        }

        method_exchangeImplementations(original, replaced)
        return nil
    }()
}

@objc private class AXClientiOS_Standin: NSObject {
    func originalDefaultParameters() -> NSDictionary {
        let selector = Selector(("defaultParameters"))
        let swizzeledSelector = #selector(swizzledDefaultParameters)
        let imp = class_getMethodImplementation(AXClientiOS_Standin.self, swizzeledSelector)
        typealias Method = @convention(c) (NSObject, Selector) -> NSDictionary
        let method = unsafeBitCast(imp, to: Method.self)
        return method(self, selector)
    }

    @objc func swizzledDefaultParameters() -> NSDictionary {
        let defaultParameters = originalDefaultParameters().mutableCopy() as! NSMutableDictionary

        for (key, value) in _overwriteDefaultParameters {
            defaultParameters[key] = value
        }

        return defaultParameters
    }
}
