// Derived from Maestro by mobile.dev (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// maestro-android/src/androidTest/java/dev/mobile/maestro/MaestroDriverService.kt, licensed under the Apache License, Version 2.0
// (see native/LICENSE-APACHE).
// Modified for react-native-eye: rewritten: HTTP/1.1 + JSON on an abstract Unix socket instead of gRPC on TCP.
package dev.rneye.server

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import dev.rneye.server.http.HttpServer
import org.junit.Test
import org.junit.runner.RunWith

/** A name the host generated (`rneye-<hex>`); anything else is refused rather than guessed. */
private val SOCKET_NAME_RE = Regex("^[A-Za-z0-9._-]{1,100}$")

/**
 * The server is a never-ending instrumentation test, started by the host with
 * `am instrument -w -e class dev.rneye.server.DriverService#server -e socket rneye-<random> …`.
 * It listens on that abstract Unix socket only (see HttpServer); there is no TCP port.
 */
@RunWith(AndroidJUnit4::class)
class DriverService {
    @Test
    fun server() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val socket = InstrumentationRegistry.getArguments().getString("socket")
        require(socket != null && SOCKET_NAME_RE.matches(socket)) {
            "missing or invalid -e socket <name> (got ${socket ?: "none"})"
        }
        Configurator.getInstance().apply {
            waitForIdleTimeout = 0
            waitForSelectorTimeout = 0
            actionAcknowledgmentTimeout = 0
            scrollAcknowledgmentTimeout = 0
            keyInjectionDelay = 0
        }
        HttpServer(socket, Routes(instrumentation, BuildConfig.RNE_VERSION).table()).serveForever()
    }
}
