// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: private-class lookups throw AppError.unsupported instead of
// crashing; the unused send(string:) was removed.

import Foundation

@MainActor
class RunnerDaemonProxy {
    private let proxy: NSObject

    init() throws {
        let clazz: AnyClass = try PrivateAPI.lookUpClass("XCTRunnerDaemonSession")
        let selector = try PrivateAPI.classSelector(clazz, "sharedSession")
        let imp = clazz.method(for: selector)
        typealias Method = @convention(c) (AnyClass, Selector) -> NSObject?
        let method = unsafeBitCast(imp, to: Method.self)
        guard let session = method(clazz, selector) else {
            throw AppError.unsupported("+[XCTRunnerDaemonSession sharedSession] returned nil")
        }

        proxy = try PrivateAPI.performReturningObject(session, "daemonProxy")
    }

    func synthesize(eventRecord: EventRecord) async throws {
        let selector = try PrivateAPI.selector(on: proxy, "_XCT_synthesizeEvent:completion:")
        let imp = proxy.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSObject, @escaping (Error?) -> ()) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            method(proxy, selector, eventRecord.eventRecord, { error in
                if let error = error {
                    continuation.resume(with: .failure(error))
                } else {
                    continuation.resume(with: .success(()))
                }
            })
        }
    }
}
