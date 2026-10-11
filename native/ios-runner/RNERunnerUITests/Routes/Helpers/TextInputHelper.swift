// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: private-API calls throw AppError.unsupported; empty text is a no-op.

import Foundation
import os
import XCTest

@MainActor
struct TextInputHelper {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    private enum Constants {
        static let typingFrequency = 30
        static let slowInputCharactersCount = 1
    }

    static func waitUntilKeyboardIsPresented() async {
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline {
            let app = (try? RunningApp.getForegroundApp()) ?? XCUIApplication(bundleIdentifier: RunningApp.springboardBundleId)
            if app.keyboards.firstMatch.exists { return }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    static func inputText(_ text: String) async throws {
        if text.isEmpty { return }
        // due to different keyboard input listener events (i.e. autocorrection or hardware keyboard connection)
        // characters after the first on are often skipped, so we'll input it with lower typing frequency
        let firstCharacter = String(text.prefix(Constants.slowInputCharactersCount))
        logger.info("first character: \(firstCharacter)")
        var eventPath = try PointerEventPath.pathForTextInput()
        try eventPath.type(text: firstCharacter, typingSpeed: 1)
        let eventRecord = try EventRecord(orientation: ScreenSizeHelper.currentInterfaceOrientation())
        _ = try eventRecord.add(eventPath)
        try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)

        // wait 500 ms before dispatching next input text request to avoid iOS dropping characters
        try await Task.sleep(nanoseconds: UInt64(1_000_000_000 * 0.5))

        if (text.count > Constants.slowInputCharactersCount) {
            let remainingText = String(text.suffix(text.count - Constants.slowInputCharactersCount))
            logger.info("remaining text: \(remainingText)")
            var eventPath2 = try PointerEventPath.pathForTextInput()
            try eventPath2.type(text: remainingText, typingSpeed: Constants.typingFrequency)
            let eventRecord2 = try EventRecord(orientation: ScreenSizeHelper.currentInterfaceOrientation())
            _ = try eventRecord2.add(eventPath2)
            try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord2)
        }
    }
}
