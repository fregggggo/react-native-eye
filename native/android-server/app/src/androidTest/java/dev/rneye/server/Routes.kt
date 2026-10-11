// Derived from Maestro by mobile.dev (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// maestro-android/src/androidTest/java/dev/mobile/maestro/MaestroDriverService.kt, licensed under the Apache License, Version 2.0
// (see native/LICENSE-APACHE).
// Modified for react-native-eye: rewritten as HTTP route handlers.
package dev.rneye.server

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.os.Build
import android.util.DisplayMetrics
import android.view.KeyEvent
import android.view.WindowManager
import android.content.Context
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiDeviceExt.clickExt
import dev.rneye.server.http.Handler
import dev.rneye.server.http.HttpError
import dev.rneye.server.http.Request
import dev.rneye.server.http.Response
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max

/**
 * Route table. Every route that drives UiAutomation holds one lock: the accessibility
 * connection is not safe for concurrent use. /status and /deviceInfo stay outside the lock,
 * so a liveness probe never waits behind a 10 s hierarchy dump.
 */
class Routes(private val instrumentation: Instrumentation, private val version: String) {
    private val device = UiDevice.getInstance(instrumentation)
    private val uiAutomation: UiAutomation get() = instrumentation.uiAutomation
    private val lock = ReentrantLock()
    private val gestures = Gestures { instrumentation.uiAutomation }

    init { ToastAccessibilityListener.start(uiAutomation) }

    fun table(): Map<String, Handler> = mapOf(
        "/status" to ::status,
        "/deviceInfo" to ::deviceInfo,
        "/viewHierarchy" to locked(::viewHierarchy),
        "/touch" to locked(::touch),
        "/swipe" to locked(::swipe),
        "/inputText" to locked(::inputText),
        "/eraseText" to locked(::eraseText),
        "/pressKey" to locked(::pressKey),
        "/pressButton" to locked(::pressButton),
        "/screenshot" to locked(::screenshot),
        "/isScreenStatic" to locked(::isScreenStatic),
    )

    private fun locked(h: Handler): Handler = { req -> lock.withLock { h(req) } }
    private fun ok() = Response.json(JSONObject())

    /** 503 once UiAutomation is disconnected (e.g. `am` died): the host must re-warm, not reuse. */
    private fun status(@Suppress("UNUSED_PARAMETER") req: Request): Response {
        val alive = runCatching { uiAutomation.windows.isNotEmpty() || uiAutomation.rootInActiveWindow != null }.getOrDefault(false)
        if (!alive) throw HttpError(503, "unavailable", "UiAutomation is not connected")
        return Response.json(JSONObject().put("status", "ok").put("version", version))
    }

    private fun deviceInfo(@Suppress("UNUSED_PARAMETER") req: Request): Response {
        val wm = instrumentation.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val (w, h) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wm.currentWindowMetrics.bounds.let { it.width() to it.height() }
        } else {
            DisplayMetrics().also { @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(it) }.let { it.widthPixels to it.heightPixels }
        }
        return Response.json(JSONObject().put("widthPixels", w).put("heightPixels", h))
    }

    /** Maestro's refreshAccessibilityCache: settle 500 ms, then reset serviceInfo to drop stale nodes. */
    private fun viewHierarchy(@Suppress("UNUSED_PARAMETER") req: Request): Response {
        try { device.waitForIdle(500); uiAutomation.serviceInfo = null } catch (_: NullPointerException) {}
        val out = ByteArrayOutputStream()
        val toast = if (ToastAccessibilityListener.isTimedOut()) null else ToastAccessibilityListener.getToastAccessibilityNode()
        ViewHierarchy.dump(device, uiAutomation, out, toast)
        return Response.json(JSONObject().put("hierarchy", out.toString("UTF-8")))
    }

    private fun touch(req: Request): Response {
        val b = req.json()
        val x = intArg(b, "x"); val y = intArg(b, "y")
        val duration = if (b.has("durationMs")) b.getLong("durationMs") else 0L
        if (duration <= 0) device.clickExt(x, y)
        // Held for durationMs by the wall clock (UiDevice.swipe's step pacing overshoots ~9×).
        else gestures.press(x, y, duration)
        return ok()
    }

    private fun swipe(req: Request): Response {
        val b = req.json()
        val duration = if (b.has("durationMs")) b.getLong("durationMs") else 300L
        gestures.swipe(intArg(b, "startX"), intArg(b, "startY"), intArg(b, "endX"), intArg(b, "endY"), max(0L, duration))
        return ok()
    }

    /** Printable ASCII only: the host sends everything else through the IME. */
    private fun inputText(req: Request): Response {
        val text = req.json().optString("text", "")
        val bad = text.firstOrNull { it.code !in 0x20..0x7e }
        if (bad != null) throw HttpError(400, "invalid_text", "inputText takes printable ASCII only (got U+%04X); non-ASCII goes through the IME".format(bad.code))
        text.forEach { KeyText.type(device, it.toString()); Thread.sleep(75) }
        return ok()
    }

    private fun eraseText(req: Request): Response {
        repeat(max(0, req.json().optInt("charactersToErase", 0))) { device.pressDelete() }
        return ok()
    }

    private fun pressKey(req: Request): Response {
        val key = req.json().optString("key")
        val code = when (key) {
            "back" -> KeyEvent.KEYCODE_BACK; "home" -> KeyEvent.KEYCODE_HOME; "delete" -> KeyEvent.KEYCODE_DEL
            "enter" -> KeyEvent.KEYCODE_ENTER; "tab" -> KeyEvent.KEYCODE_TAB; "space" -> KeyEvent.KEYCODE_SPACE
            "escape" -> KeyEvent.KEYCODE_ESCAPE
            else -> throw HttpError(400, "invalid_key", "unknown key '$key' (back, home, delete, enter, tab, space, escape)")
        }
        device.pressKeyCode(code)
        return ok()
    }

    private fun pressButton(req: Request): Response {
        when (val button = req.json().optString("button")) {
            "home" -> device.pressHome()
            "lock" -> device.pressKeyCode(KeyEvent.KEYCODE_SLEEP)
            else -> throw HttpError(400, "invalid_button", "unknown button '$button' (home, lock)")
        }
        return ok()
    }

    /** takeScreenshot returns null while the display is changing; three tries with backoff. */
    private fun screenshot(@Suppress("UNUSED_PARAMETER") req: Request): Response {
        for (attempt in 0 until 3) {
            val bitmap = uiAutomation.takeScreenshot()
            if (bitmap != null) {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                bitmap.recycle()
                return Response.png(out.toByteArray())
            }
            Thread.sleep(100L shl attempt)
        }
        throw HttpError(500, "screenshot_failed", "UiAutomation.takeScreenshot returned null 3 times")
    }

    private fun isScreenStatic(@Suppress("UNUSED_PARAMETER") req: Request): Response {
        val updating = device.waitForWindowUpdate(device.currentPackageName, 500)
        return Response.json(JSONObject().put("isScreenStatic", !updating))
    }

    private fun intArg(b: JSONObject, name: String): Int {
        if (!b.has(name)) throw HttpError(400, "bad_request", "missing '$name'")
        return b.getDouble(name).toInt()
    }
}
