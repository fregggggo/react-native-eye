package dev.rneye.server

import android.app.UiAutomation
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import kotlin.math.min

/**
 * Touch gestures injected through UiAutomation.injectInputEvent, paced by the wall clock.
 *
 * UiDevice.swipe(steps) sleeps a fixed 5 ms per step on top of a synchronous injection that
 * costs 15–45 ms on an emulator, so a 300 ms swipe took ~1.2 s and an 800 ms long press ~7.5 s
 * (measured on API 36). Here the MOVE positions follow elapsed time instead of a step count,
 * so a gesture lasts its requested duration whatever one injection costs.
 */
class Gestures(private val uiAutomation: () -> UiAutomation) {

    /** Press at (x, y), hold for [durationMs], release. A long press when durationMs ≥ ~500. */
    fun press(x: Int, y: Int, durationMs: Long) = swipe(x, y, x, y, durationMs)

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) {
        val down = SystemClock.uptimeMillis()
        inject(down, down, MotionEvent.ACTION_DOWN, x1.toFloat(), y1.toFloat())
        var x = x1.toFloat(); var y = y1.toFloat()
        try {
            if (x1 == x2 && y1 == y2) {
                SystemClock.sleep(durationMs)
            } else {
                while (true) {
                    val elapsed = SystemClock.uptimeMillis() - down
                    val t = if (durationMs <= 0) 1f else min(1f, elapsed.toFloat() / durationMs)
                    x = x1 + (x2 - x1) * t; y = y1 + (y2 - y1) * t
                    inject(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x, y)
                    if (t >= 1f) break
                    SystemClock.sleep(MOVE_INTERVAL_MS)
                }
            }
        } finally {
            inject(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y)
        }
    }

    private fun inject(downTime: Long, eventTime: Long, action: Int, x: Float, y: Float) {
        val ev = MotionEvent.obtain(downTime, eventTime, action, x, y, 1f, 1f, 0, 1f, 1f, 0, 0)
        ev.source = InputDevice.SOURCE_TOUCHSCREEN
        try {
            if (!uiAutomation().injectInputEvent(ev, true)) {
                throw IllegalStateException("injectInputEvent refused ${MotionEvent.actionToString(action)} at $x,$y")
            }
        } finally {
            ev.recycle()
        }
    }

    private companion object { const val MOVE_INTERVAL_MS = 8L }
}
