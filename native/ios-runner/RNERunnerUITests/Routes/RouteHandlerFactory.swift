// Derived from Maestro (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// licensed under the Apache License, Version 2.0 (see native/LICENSE-APACHE).
// Modified for react-native-eye: only the routes of the react-native-eye API.

import Foundation
import FlyingFox

class RouteHandlerFactory {
    @MainActor class func createRouteHandler(route: Route) -> HTTPHandler {
        switch route {
        case .status:
            return StatusHandler()
        case .viewHierarchy:
            return ViewHierarchyHandler()
        case .touch:
            return TouchRouteHandler()
        case .swipe:
            return SwipeRouteHandler()
        case .inputText:
            return InputTextRouteHandler()
        case .eraseText:
            return EraseTextHandler()
        case .pressKey:
            return PressKeyHandler()
        case .pressButton:
            return PressButtonHandler()
        case .screenshot:
            return ScreenshotHandler()
        case .isScreenStatic:
            return IsScreenStaticHandler()
        case .deviceInfo:
            return DeviceInfoHandler()
        }
    }
}
