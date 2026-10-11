# Third-party code in native/android-server

Parts of this Gradle project are copied from **Maestro** (<https://github.com/mobile-dev-inc/maestro>,
module `maestro-android`, commit `c436d39`), licensed under the Apache License 2.0. The license text
is in [`../LICENSE-APACHE`](../LICENSE-APACHE).

## Copied files and changes

| Maestro file (`maestro-android/src/…`) | Here (`app/src/…`) | Change |
|---|---|---|
| `androidTest/java/dev/mobile/maestro/ViewHierarchy.kt` | `androidTest/java/dev/rneye/server/ViewHierarchy.kt` | package → `dev.rneye.server`; `LOGTAG` → `"RNEye"`; the `getWindowRoots` fallback skips a null root; the toast node gets an estimated bottom-centre rectangle instead of empty bounds; skipped (invisible or null) children are no longer logged |
| `androidTest/java/dev/mobile/maestro/AccessibilityNodeInfoExt.kt` | `androidTest/java/dev/rneye/server/AccessibilityNodeInfoExt.kt` | package only |
| `androidTest/java/dev/mobile/maestro/ToastAccessibilityListener.kt` | `androidTest/java/dev/rneye/server/ToastAccessibilityListener.kt` | package; dropped `import kotlin.reflect.jvm.jvmName`; `Toast::class.jvmName` → `Toast::class.java.name` (no kotlin-reflect); the node carries the event's package name |
| `androidTest/java/androidx/test/uiautomator/UiDeviceExt.kt` | same path | verbatim (must stay in `androidx.test.uiautomator` to reach `interactionController`) |
| `MaestroDriverService.kt` `setText` + `keyPressShiftedToEvents` | `androidTest/java/dev/rneye/server/KeyText.kt` | wrapped in `object KeyText { fun type(uiDevice, text) }`; `Log.d` removed |
| `MaestroDriverService.kt` (gRPC service) | `DriverService.kt`, `http/HttpServer.kt`, `Routes.kt` | rewritten: HTTP/1.1 + JSON on an abstract Unix socket (random name per start, adbd's uid only) instead of gRPC on TCP |
| `main/java/dev/mobile/maestro/input/MaestroInputMethodService.kt` | `main/java/dev/rneye/server/input/RneInputMethodService.java` | ported to Java; runs in process `:ime` |
| `main/java/dev/mobile/maestro/receivers/UnicodeInputReceiver.kt` | `main/java/dev/rneye/server/receivers/UnicodeInputReceiver.java` | ported to Java; base64url extra `textBase64`; success result code `-1` (`Activity.RESULT_OK`) instead of `0`, error `1`; process `:ime` |
| `gradlew`, `gradlew.bat`, `gradle/wrapper/*` (repo root) | same paths | verbatim (Gradle 8.13 wrapper) |

## Not carried over

`Media.kt`, `screenshot/*` (kotlin-retry, protobuf), `location/*` (Play Services),
`LocaleSettingReceiver`, `handlers/*`, `HasAction.kt`, hiddenapibypass, commons-lang3, espresso,
grpc/netty/protobuf, and every permission (including `INTERNET`: the server needs no TCP).

The copied and ported files carry a "Derived from Maestro … Modified for react-native-eye" header
naming the upstream file; the verbatim ones (`UiDeviceExt.kt`, the Gradle wrapper) are left as they are.

## Libraries in the built APKs

The app APK has no dependencies. The test APK bundles, through androidx.test:

| Library | License |
|---|---|
| AndroidX Test (runner, monitor, ext:junit, uiautomator), AndroidX Tracing, AndroidX Concurrent | Apache-2.0 (`../LICENSE-APACHE`) |
| Kotlin stdlib, kotlinx.coroutines | Apache-2.0 (`../LICENSE-APACHE`) |
| JUnit 4.13.2 | EPL-1.0 — [`licenses/junit-4.13.2-EPL-1.0.txt`](licenses/junit-4.13.2-EPL-1.0.txt) (also inside the APK as `LICENSE-junit.txt`) |
| Hamcrest-core 1.3 | BSD-3-Clause — [`licenses/hamcrest-core-1.3-BSD-3-Clause.txt`](licenses/hamcrest-core-1.3-BSD-3-Clause.txt) |

## Our own files

`ProbeActivity.java` (test screen), `http/HttpServer.kt`,
`Gestures.kt` (wall-clock-paced swipe/long press; replaces `UiDevice.swipe`, whose step pacing
overran the requested duration 4–9× on an emulator), the Gradle
build files and `rneye.keystore` (a public signing key: password `rneye-public`; it only has to stay
stable so that `adb install -r` updates a previous build).
