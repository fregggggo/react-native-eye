// Added for react-native-eye (not part of Maestro).
//
// Every lookup of a private XCTest class or selector goes through here, so a symbol that
// Apple renamed or removed becomes `AppError.unsupported(<symbol>)` (HTTP 501) instead of a
// force-unwrap crash that kills the runner.

import Foundation
import ObjectiveC

enum PrivateAPI {
    /// `objc_lookUpClass(name)` or throw `unsupported(name)`.
    static func lookUpClass(_ name: String) throws -> AnyClass {
        guard let cls = objc_lookUpClass(name) else {
            throw AppError.unsupported(name)
        }
        return cls
    }

    /// Instance selector that instances of `cls` must respond to, or throw `unsupported("-[Class sel]")`.
    static func instanceSelector(_ cls: AnyClass, _ name: String) throws -> Selector {
        let selector = NSSelectorFromString(name)
        guard class_respondsToSelector(cls, selector) else {
            throw AppError.unsupported("-[\(NSStringFromClass(cls)) \(name)]")
        }
        return selector
    }

    /// Instance selector that `object` must respond to, or throw `unsupported("-[Class sel]")`.
    /// Uses `responds(to:)` on the instance (not the class) because XPC proxies such as the
    /// testmanagerd `daemonProxy` answer `respondsToSelector:` from their protocol, not their class.
    static func selector(on object: NSObject, _ name: String) throws -> Selector {
        let selector = NSSelectorFromString(name)
        guard object.responds(to: selector) else {
            throw AppError.unsupported("-[\(NSStringFromClass(type(of: object))) \(name)]")
        }
        return selector
    }

    /// Class selector that `cls` must respond to, or throw `unsupported("+[Class sel]")`.
    static func classSelector(_ cls: AnyClass, _ name: String) throws -> Selector {
        let selector = NSSelectorFromString(name)
        guard let metaclass = object_getClass(cls), class_respondsToSelector(metaclass, selector) else {
            throw AppError.unsupported("+[\(NSStringFromClass(cls)) \(name)]")
        }
        return selector
    }

    /// `object.perform(selector)` returning an object, or throw `unsupported(symbol)` when the
    /// selector is missing or the call returns nil / a non-NSObject.
    static func performReturningObject(_ object: NSObject, _ name: String) throws -> NSObject {
        let selector = try self.selector(on: object, name)
        guard let result = object.perform(selector)?.takeUnretainedValue() as? NSObject else {
            throw AppError.unsupported("-[\(NSStringFromClass(type(of: object))) \(name)] returned nil")
        }
        return result
    }
}
