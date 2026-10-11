// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: getForegroundApp() checks the private APIs behind
// XCUIApplication.activeAppsInfo() and throws AppError.unsupported when one is missing;
// the unused getForegroundAppId(_:) (appIds) was removed.

import Foundation
import XCTest
import os

struct RunningApp {

    static let springboardBundleId = "com.apple.springboard"
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )
    private init() {}

    /// nil when every private symbol used by `activeAppsInfo()` (Categories/XCUIApplication+Helper.m,
    /// Utilities/AXClientProxy.m, Utilities/XCTestDaemonsProxy.m) exists; otherwise the error to throw.
    /// Those are Objective-C call sites: a missing selector there raises an NSException that
    /// would kill the runner, so it is checked here, once, before they run.
    private static let activeAppsSupport: AppError? = {
        let device = XCUIDevice.shared
        guard device.responds(to: NSSelectorFromString("accessibilityInterface")),
              let axClient = device.perform(NSSelectorFromString("accessibilityInterface"))?.takeUnretainedValue() as? NSObject else {
            return AppError.unsupported("-[XCUIDevice accessibilityInterface]")
        }
        guard axClient.responds(to: NSSelectorFromString("activeApplications")) else {
            return AppError.unsupported("-[XCAXClient_iOS activeApplications]")
        }
        guard let sessionClass = NSClassFromString("XCTRunnerDaemonSession") else {
            return AppError.unsupported("XCTRunnerDaemonSession")
        }
        let sharedSession = NSSelectorFromString("sharedSession")
        guard (sessionClass as AnyObject).responds(to: sharedSession),
              let session = (sessionClass as AnyObject).perform(sharedSession)?.takeUnretainedValue() as? NSObject else {
            return AppError.unsupported("+[XCTRunnerDaemonSession sharedSession]")
        }
        guard session.responds(to: NSSelectorFromString("daemonProxy")),
              let proxy = session.perform(NSSelectorFromString("daemonProxy"))?.takeUnretainedValue() as? NSObject else {
            return AppError.unsupported("-[XCTRunnerDaemonSession daemonProxy]")
        }
        guard proxy.responds(to: NSSelectorFromString("_XCT_requestBundleIDForPID:reply:")) else {
            return AppError.unsupported("-[XCTestManager_ManagerInterface _XCT_requestBundleIDForPID:reply:]")
        }
        return nil
    }()

    static func getForegroundApp() throws -> XCUIApplication? {
        if let error = activeAppsSupport {
            throw error
        }
        let runningAppIds = XCUIApplication.activeAppsInfo().compactMap { $0["bundleId"] as? String }

        NSLog("Detected running apps: \(runningAppIds)")

        // Only return an app that is actually foreground for automation. A process can appear in
        // activeAppsInfo() while its XCUIApplication state is not yet .runningForeground (e.g. showing
        // a splash screen). Snapshotting it then throws "Application ... is not running", which callers
        // escalate as a fatal AppCrash. Returning nil instead lets callers fall back to the springboard hierarchy
        // and retry.
        return runningAppIds
            .map { XCUIApplication(bundleIdentifier: $0) }
            .first { $0.state == .runningForeground }
    }

}
