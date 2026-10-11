// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: private selectors throw AppError.unsupported instead of crashing.

import Foundation
import XCTest

@MainActor
struct EventTarget {

    let eventTarget: NSObject

    init() throws {
        let application = try RunningApp.getForegroundApp() ?? XCUIApplication(bundleIdentifier: RunningApp.springboardBundleId)
        let element = application.children(matching: .any).firstMatch
        eventTarget = try PrivateAPI.performReturningObject(element, "eventTarget")
    }

    typealias EventBuilder = () throws -> EventRecord
    func dispatchEvent(description: String, builder: EventBuilder) async throws {
        let selector = try PrivateAPI.selector(on: eventTarget, "dispatchEventWithDescription:eventBuilder:error:")
        let imp = eventTarget.method(for: selector)

        // Build the record up front: a missing private class must surface as a thrown
        // AppError here, not inside the ObjC block where it cannot propagate.
        let record = try builder().eventRecord

        typealias EventBuilderObjc = @convention(block) () -> NSObject
        typealias Method = @convention(c) (NSObject, Selector, String, EventBuilderObjc, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
        var error: NSError?
        let method = unsafeBitCast(imp, to: Method.self)

        _ = method(
            eventTarget,
            selector,
            description,
            { record },
            &error
        )

        if let error = error {
            throw error
        }
    }
}
