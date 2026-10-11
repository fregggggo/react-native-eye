// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: private-class lookups throw AppError.unsupported instead of crashing.

import Foundation
import UIKit

@objc
final class EventRecord: NSObject {
    let eventRecord: NSObject
    static let defaultTapDuration = 0.1

    enum Style: String {
        case singeFinger = "Single-Finger Touch Action"
        case multiFinger = "Multi-Finger Touch Action"
    }

    init(orientation: UIInterfaceOrientation, style: Style = .singeFinger) throws {
        let cls: AnyClass = try PrivateAPI.lookUpClass("XCSynthesizedEventRecord")
        let initSelector = try PrivateAPI.instanceSelector(cls, "initWithName:interfaceOrientation:")
        guard let alloced = cls.alloc() as? NSObject,
              let record = alloced
                .perform(initSelector, with: style.rawValue, with: orientation)?
                .takeUnretainedValue() as? NSObject else {
            throw AppError.unsupported("-[XCSynthesizedEventRecord initWithName:interfaceOrientation:] returned nil")
        }
        eventRecord = record
    }

    func addPointerTouchEvent(at point: CGPoint, touchUpAfter: TimeInterval?) throws -> Self {
        var path = try PointerEventPath.pathForTouch(at: point)
        path.offset += touchUpAfter ?? Self.defaultTapDuration
        try path.liftUp()
        return try add(path)
    }

    func addSwipeEvent(start: CGPoint, end: CGPoint, duration: TimeInterval) throws -> Self {
        var path = try PointerEventPath.pathForTouch(at: start)
        path.offset += Self.defaultTapDuration
        try path.moveTo(point: end)
        path.offset += duration
        try path.liftUp()
        return try add(path)
    }

    func add(_ path: PointerEventPath) throws -> Self {
        let selector = try PrivateAPI.selector(on: eventRecord, "addPointerEventPath:")
        let imp = eventRecord.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSObject) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(eventRecord, selector, path.path)
        return self
    }
}
