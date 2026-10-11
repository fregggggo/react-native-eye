// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: private-class lookups throw AppError.unsupported instead of crashing.

import Foundation

struct PointerEventPath {

    static func pathForTouch(at point: CGPoint, offset: TimeInterval = 0) throws -> Self {
        let alloced = try allocPath()
        let selector = try PrivateAPI.selector(on: alloced, "initForTouchAtPoint:offset:")
        let imp = alloced.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let method = unsafeBitCast(imp, to: Method.self)
        let path = method(alloced, selector, point, offset)
        return Self(path: path, offset: offset)
    }

    static func pathForTextInput(offset: TimeInterval = 0) throws -> Self {
        let alloced = try allocPath()
        let selector = try PrivateAPI.selector(on: alloced, "initForTextInput")
        let imp = alloced.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector) -> NSObject
        let method = unsafeBitCast(imp, to: Method.self)
        let path = method(alloced, selector)
        return Self(path: path, offset: offset)
    }

    private static func allocPath() throws -> NSObject {
        let cls: AnyClass = try PrivateAPI.lookUpClass("XCPointerEventPath")
        guard let alloced = cls.alloc() as? NSObject else {
            throw AppError.unsupported("+[XCPointerEventPath alloc]")
        }
        return alloced
    }

    let path: NSObject
    var offset: TimeInterval

    private init(path: NSObject, offset: TimeInterval) {
        self.path = path
        self.offset = offset
    }

    mutating func liftUp() throws {
        let selector = try PrivateAPI.selector(on: path, "liftUpAtOffset:")
        let imp = path.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, TimeInterval) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(path, selector, offset)
    }

    mutating func moveTo(point: CGPoint) throws {
        let selector = try PrivateAPI.selector(on: path, "moveToPoint:atOffset:")
        let imp = path.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(path, selector, point, offset)
    }

    mutating func type(text: String, typingSpeed: Int, shouldRedact: Bool = false) throws {
        let selector = try PrivateAPI.selector(on: path, "typeText:atOffset:typingSpeed:shouldRedact:")
        let imp = path.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSString, TimeInterval, UInt64, Bool) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(path, selector, text as NSString, offset, UInt64(typingSpeed), shouldRedact)
    }

    mutating func set(modifiers: KeyModifierFlags = []) throws {
        let selector = try PrivateAPI.selector(on: path, "setModifiers:mergeWithCurrentModifierFlags:atOffset:")
        let imp = path.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, UInt64, Bool, TimeInterval) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(path, selector, modifiers.rawValue, false, offset)
    }
}
