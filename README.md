<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-on-dark.svg">
    <img alt="" src="assets/logo-on-light.svg" width="112" height="112">
  </picture>
</p>

<h1 align="center">react-native-eye</h1>

<p align="center">
  <strong>An MCP server that gives AI agents eyes and hands in a running React Native app.</strong>
</p>

<p align="center">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-61DAFB">
  <img alt="Node 18 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2018-61DAFB">
  <img alt="iOS and Android" src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android-61DAFB">
  <img alt="35 tools" src="https://img.shields.io/badge/tools-35-61DAFB">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-61DAFB">
</p>

react-native-eye connects Claude Code, Cursor or any other MCP client to your app through Metro's Chrome DevTools Protocol endpoint. The agent reads the screen, taps and types, and checks logs, network and state. The app needs no SDK and no code changes.

It is built for agent speed. Composite tools run a whole interaction in one call, so the agent does not pay one model round trip per tap.

```text
› observe

LAYOUT (js):
Welcome back @196,188
Email @196,312
Password @196,380
Log in @196,468
Forgot password? @196,532
Create account @196,772

ERRORS:
none

LOGS:
[log] auth: no saved session
```

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [What the agent can do](#what-the-agent-can-do)
- [A whole flow in one call](#a-whole-flow-in-one-call)
- [How it works](#how-it-works)
- [Tool reference](#tool-reference)
- [Configuration](#configuration)
- [Native driver](#native-driver)
- [Privacy](#privacy)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Quick start

**1. Add the server to your MCP client.**

Claude Code, from your project folder:

```sh
claude mcp add react-native-eye -- npx -y react-native-eye@latest
```

Cursor (`.cursor/mcp.json`), Claude Desktop and any other client that takes the standard config:

```json
{
  "mcpServers": {
    "react-native-eye": {
      "command": "npx",
      "args": ["-y", "react-native-eye@latest"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.react-native-eye]
command = "npx"
args = ["-y", "react-native-eye@latest"]
```

**2. Start Metro and a dev build.** Run the app in an iOS simulator or an Android emulator the way you usually do. Metro on the standard ports (8081–8083, 19000–19002) is found automatically. For any other port, pass `--port 8090` in `args`, set `METRO_PORT`, or give the port to the `connect` tool.

**3. Ask the agent.**

> Connect to my app and tell me what is on the screen.

The agent calls `connect`, then `observe`. The first call on each device installs the [native driver](#native-driver) once.

## Requirements

| | |
|---|---|
| **Node** | 18 or newer |
| **App** | React Native 0.70+ or Expo SDK 54+, as a dev build with Metro and Hermes running |
| **iOS** | macOS with Xcode and a simulator. [AXe CLI](https://github.com/cameroncooke/AXe) (`brew install cameroncooke/axe/axe`) is the fallback for OS input and OS layout when the native driver is unavailable or switched off |
| **Android** | `adb` (Android platform-tools) on your PATH |
| **OCR** (`read_screen_text`) | A macOS host with the Xcode Command Line Tools (`xcode-select --install`). The Apple Vision helper is compiled once on first use into `~/Library/Caches/react-native-eye` |

The JS paths (layout from the runtime, `via: "js"` taps and typing) need only a connected app.

## What the agent can do

35 tools in five groups. Tools in **bold** are composite: one call instead of many. Prefer them.

| Group | Tools |
|---|---|
| **See the screen** | **`observe`**, `screenshot`, `get_layout`, `read_screen_text`, `get_component_tree` |
| **Act** | **`run_flow`**, `tap`, `type_text`, `swipe`, `scroll_to`, `press_key`, `navigate`, `open_url` |
| **Debug** | **`check_state`**, `get_logs`, `get_errors`, `get_network`, `get_state`, `eval_js`, `get_job` |
| **Measure** | `profile_renders`, `profile_js`, `sample_cpu`, `get_fps` |
| **Manage devices** | `connect`, `list_targets`, `list_devices`, `launch_app`, `reload_app`, `install_app`, `open_simulator`, `set_permission`, `record_video`, `stop_recording`, `ping` |

The composite tools:

| Tool | What it does |
|---|---|
| `observe` | Screenshot + interactive elements + recent errors + recent logs, in one call |
| `run_flow` | A whole UI flow server-side: taps, typing, waits, assertions — aborts instantly on app errors, returns per-step results + an observe at the stop point |
| `check_state` | Current route + store state + unhandled errors |

## A whole flow in one call

```json
{ "steps": [
  { "tap": { "text": "Login" } },
  { "wait_for": { "text": "Email", "timeout_ms": 3000 } },
  { "type": { "text": "a@b.c", "into": { "placeholder": "Email" } } },
  { "tap": { "testID": "submit-btn", "via": "os" } },
  { "expect": { "text": "Welcome" } },
  { "expect_not": { "text": "Error" } }
] }
```

```text
Flow completed.

1. tap({"text":"Login"}) — ok (input: js)
2. wait_for({"text":"Email","timeout_ms":3000}) — ok
3. type({"text":"a@b.c","into":{"placeholder":"Email"}}) — ok (input: js)
4. tap({"testID":"submit-btn","via":"os"}) — ok (input: os/runner)
5. expect({"text":"Welcome"}) — ok
6. expect_not({"text":"Error"}) — ok
```

Each step takes exactly one action (`settle` is a modifier) — a step with two actions is a validation error, not a silently skipped assertion. Steps run back-to-back with adaptive settling (two rendered frames, capped at 1s; override per step with `"settle": 200`). A redbox or uncaught exception anywhere in the flow aborts it immediately with full context, and steps that never ran are listed as such.

`tap` and `type` steps take the same selectors, `via` and `into` as the standalone tools — `into` accepts `{testID}`, `{placeholder}` or `{label}`, and a bare string is still a testID — and each step's result names the path it used. A step that asks for `via: "os"` gets a real touch even when a JS press was available: use it for anything driven by the responder lifecycle, and leave the default `auto` everywhere else.

## How it works

The server reaches the app two ways and picks the cheaper one for each call.

```text
Your agent (Claude Code, Cursor, Codex)
        │  MCP · stdio
        ▼
react-native-eye (on your machine)
        ├── CDP · Metro ──────▶ JS runtime (Hermes): layout, presses, typing, logs, network, state
        └── HTTP · localhost ─▶ Driver on the device: real touches, keys, OS view hierarchy, screenshots
```

**Through the JS runtime.** The server walks React's fiber tree over CDP. It measures elements and calls press and text handlers directly, with no touch involved. A press takes about a millisecond and a full-screen layout about 80 ms.

**Through the device.** A prebuilt driver ships in the npm package and installs itself on first use: an XCUITest runner on iOS, an instrumentation server on Android. It delivers real touches for gestures, system dialogs and native views, and types any Unicode text on Android. If it cannot start, input falls back to axe or adb.

**No silent switching.** Every response says which path ran: `(input: js)`, `(input: os/runner)`, `(layout: js)`, `(layout: os)`, with the reason when a path was skipped.

Measured in the project's own field tests against a busy video feed:

| | Native driver | The tool it replaces |
|---|---|---|
| iOS simulator, one feed swipe, median of 40 | **0.93 s** | axe: 26.68 s, 3 of 40 timed out at 90 s |
| Android emulator, view hierarchy over a playing video, median of 10 | **4.60 s**, 10 of 10 answered | `uiautomator dump`: 27.10 s, 9 of 10 failed |

## Tool reference

Three parameters appear on many tools.

- **`device`** — on every device-facing tool (`tap`, `swipe`, `scroll_to`, `type_text`, `press_key`, `screenshot`, `get_layout`, `read_screen_text`, `observe`, `run_flow`, `launch_app`, `install_app`, `open_url`, `set_permission`, `record_video`): a udid or device-name substring. Without it the device is taken from the connected app's target, and two booted devices with no hint is an error rather than a silent guess.
- **`via`** — on `tap`, `type_text`, `scroll_to`, `swipe`, `press_key` and the `tap`/`type` steps of `run_flow`: `"js" | "os" | "auto"`, default `auto`.
  - `js` goes through the app's own fiber tree — the element under the resolved point is found, its nearest `onPress`/`onChangeText` is called directly, and the whole round trip is about a millisecond.
  - `os` delivers a real touch or HID keystroke through the simulator or device.
  - `auto` tries `js` and falls back to `os`, naming the reason.
  - **Every response says which path ran** — `(input: js)`, or `(input: os/axe — no press handler in ancestry)` (`os/runner`, `os/axe` or `os/adb` names the OS mechanism that delivered it) — mirroring `(layout: js)`/`(layout: os)`.
  - Selector, ambiguity and visibility rules are identical on both paths: the JS path replaces delivery, not judgement, so an off-screen or hidden element is refused either way.
- **`connect`** — `port`, `target_id` (from `list_targets`), or `device`.

<details>
<summary><strong>Input</strong> — <code>tap</code>, <code>swipe</code>, <code>scroll_to</code>, <code>type_text</code>, <code>press_key</code>, <code>navigate</code>, <code>run_flow</code></summary>

- `tap` — `duration_ms` for a long press (also available on `run_flow` tap steps). On the JS path a `duration_ms` of 500 or more calls the element's `onLongPress`; an element that has none falls back to `os`, which is what the response then says.
- `swipe` — `direction` or `x1,y1,x2,y2`, `duration_ms`, `via`. The JS path scrolls the container under the start point by the gesture's own vector (`FlatList.scrollToOffset 0 → 640`), so a feed scrolls in a millisecond instead of a 20 s touch; no scroll container under the point falls back to `os` with the reason.
- `scroll_to` — `{text | testID}`, plus `via` and `max_swipes` (default 10): bring an element into view. The JS path finds the element's nearest scrollable ancestor and scrolls that container (`ScrollView`, `FlatList`/`VirtualizedList`, FlashList, `@legendapp/list`; an unrecognised container falls back to `os`). The OS path swipes toward the element, re-reading the layout after each swipe and stopping the moment it is visible. This is the missing half of `tap`'s "element is off-screen — scroll to it first".
- `type_text` — `into` chooses the field: `{"testID": "…"}`, `{"placeholder": "…"}` or `{"label": "…"}` (`accessibilityLabel`); a bare string is still read as a testID. Omitted, it types into the one `TextInput` on the focused, topmost screen and refuses — listing the candidates by placeholder and position — when there is more than one. Two instances of the same screen in a stack (each with the same composer) are told apart by react-navigation / react-native-screens state: the field on the focused screen wins and the response says so; a match only on a background screen is typed into with a warning. `submit: true` fires the field's submit handlers after typing (see `press_key enter`). `verify` (default `true`) reads the field back after typing and fails loudly, naming both strings, when what arrived is not what was sent. `via` as above; the JS path calls `onChangeText`, so the app's real pipeline (debounce, request, re-render) runs.
- `press_key` — `key: back | home | enter`, `via`, `into`. `back` on the JS path calls the react-navigation container's `goBack()`; an empty stack is reported as `Did not go back: nothing to go back to` and deliberately does *not* fall through to the hardware key (on Android that would background the app). `enter` fires the field's own `onSubmitEditing` → `onEndEditing` → `onBlur` (JS only; `into` picks the field, otherwise the focused one).
- `navigate` — `action: stack | navigate | push | back | pop | pop_to_top | reset`, with `name`/`params` (navigate, push), `count` (pop), `state` (reset). The react-navigation container is found by walking the React tree for its ref context (react-navigation 6/7, Expo Router), cached on `globalThis.__RNE_NAV__`; no app change needed. `stack` prints the focused branch level by level; every mutating action returns the new stack, and an action no navigator handled is an error carrying react-navigation's own message.
- `run_flow` — `observe` controls the trailing snapshot: `auto` (default) attaches a screenshot and adds the full layout only when the flow failed, `full` always, `none` never.

</details>

<details>
<summary><strong>Reading the screen</strong> — <code>get_layout</code>, <code>read_screen_text</code>, <code>screenshot</code>, <code>get_component_tree</code></summary>

- `get_layout` — `search` (terms matched against text/testID), `type`, `match: substring|exact`, `case_sensitive`, or `at: {x, y}` to identify the element at a point.
- `read_screen_text` — on-host OCR of the current screen (Apple Vision, nothing leaves the machine): one line per text run as `<text> @x,y`, coordinates in tap units usable directly with `tap {x,y}`. `search` (substring filters), `languages` (e.g. `["ru","en"]`; auto-detected by default), `compare_tree` (default true — lines that also exist in the JS layout are marked `[tree]`; prefer `tap {text}` for those). Sees text the layout tree cannot: images, canvases, WebViews, native dialogs.
- `screenshot` — `output_path` saves to a file (`format: png|jpeg`, `mask` on iOS) and returns the path instead of an inline image.
- `get_component_tree` — `max_depth`. The budget counts only components a developer actually authored: host components (`RCTView`, `RCTText`, ...) and structural wrappers (`forwardRef`/`memo`/context, styling HOCs like NativeWind's `cssInterop`) are free and can repeat any number of times without spending depth. RN's own dev-only infrastructure (LogBox, the debugging overlay, the root tag context) is dropped from the output entirely, not just made free. A very large tree is capped and marked `truncated` rather than returned unbounded.

</details>

<details>
<summary><strong>Debugging</strong> — <code>get_state</code>, <code>eval_js</code>, <code>get_job</code>, <code>get_network</code></summary>

- `get_state` — `path` (dot-path) and `depth`; the value is summarised inside the app, so the result is always valid JSON. `found` says whether a store exists at all; `resolved` says whether the path walked all the way to a value — a mistyped segment reports `resolved:false` with `failedAt` and `availableKeys` instead of looking identical to an honest `undefined`.
- `eval_js` — `timeout_ms` for a legitimately slow promise (default 10s). `background: true` starts the evaluation as a job and returns its id at once, for a measurement that outlives a tool call or a JS thread that is busy right now; the CDP message is queued by Hermes and runs when the thread frees. `label` names the job.
- `get_job` — `id` returns a background job's status and value (or error); without `id`, lists jobs. `profile_renders` also runs as a job with `background: true`, so a profile can be driven with `tap`/`swipe` while it collects.
- `get_network` — `search` (URL substring to keep), `exclude` (URL substrings to drop), `include_dev` (show dev-tooling noise: Metro/devtools ports and `/symbolicate`, `/logs`, `/status` on local hosts are hidden by default — the footer says how many). Query strings are cut short in the list; `detail: <seq>` has the full URL and bodies.

</details>

<details>
<summary><strong>Performance</strong> — <code>profile_renders</code>, <code>profile_js</code>, <code>sample_cpu</code>, <code>get_fps</code></summary>

All four work on a dev build with zero app setup.

| Tool | What it does |
|---|---|
| `profile_renders` | Which components rendered, how often, and how long, over a window: per-commit render roots with *why* (changed props / own state / mount), self time per component from React's profiler fields — computed per commit, not the accumulated `actualDuration` React leaves on the root. Hooks `onCommitFiberRoot` and walks only the subtrees that did work, so it costs nothing while idle and little while active |
| `profile_js` | One-shot Hermes CPU profile over CDP: busy/idle/GC split, top functions by self and inclusive time, symbolicated through Metro; the raw `.cpuprofile` is saved for Chrome DevTools |
| `sample_cpu` | CPU by thread from the host: main vs JS vs render/shadow, share of the app's work and busy fraction per thread, top native frames (macOS `sample` on the simulator, `top -H` on Android) |
| `get_fps` | Frame timing: real UI-thread frames on Android (`dumpsys gfxinfo framestats` — janky %, p50/p90/p99), and a JS-thread rAF measure on both platforms, labelled as such |

- `profile_renders` — `duration_ms` (default 5s), `top`, `background`. Needs a dev build (the React DevTools hook is what it wraps).
- `profile_js` — `duration_ms` (default 5s), `top`, `sampling_interval_us` (Hermes may ignore it — the output says so), `save` (default true, to `$RNE_OUTPUT_DIR` or `~/Downloads`).
- `sample_cpu` — `duration_s` (default 3), `app_id` when the connected target does not name the app.
- `get_fps` — `duration_ms` (default 2s), `app_id`. On iOS only the JS-thread number is available without native code: UI-thread frames need a physical device and xctrace's Core Animation instrument.

</details>

<details>
<summary><strong>Devices and apps</strong> — <code>launch_app</code>, <code>open_url</code>, <code>set_permission</code>, <code>record_video</code>, <code>ping</code></summary>

- `launch_app` — `terminate_running` restarts a running app; `env` passes launch environment variables (iOS only).
- `open_url` — opens a deeplink or universal link (`simctl openurl` on iOS, `am start -a android.intent.action.VIEW` on Android). No touch is involved, so on iOS it is by a wide margin the cheapest way to reach a screen — see the touch cost in Limitations.
- `set_permission` — `{service, status: "grant" | "revoke" | "reset", app_id?}` (`simctl privacy` on iOS, `pm grant`/`pm revoke` on Android). Granting before launch is the reliable way to keep a permission alert off the screen; dismissing one costs a touch, and on iOS some services only pick up the change after the app is terminated — the response says so rather than failing quietly.
- `record_video` / `stop_recording` — screen recording; defaults to `$RNE_OUTPUT_DIR` or `~/Downloads`. Android clips cap at 3 minutes (screenrecord limit).
- `ping` — no arguments, returns `pong`. It answers without touching Metro, the app or a device, which is exactly what makes it useful: it separates "the MCP server is not running" from "the app is not connected".

</details>

## Configuration

| Variable | Effect |
|---|---|
| `METRO_PORT` | Metro's port when it is not one of the standard ones. `--port` in `args` and the `connect` tool's `port` do the same |
| `RNE_OUTPUT_DIR` | Default directory for recordings and saved profiles (default `~/Downloads`) |
| `RNE_FILTERED_TOOLS` | Comma-separated tool names to hide |
| `RNE_CACHE_DIR` | Where the compiled OCR helper lives (default `~/Library/Caches/react-native-eye`) |
| `RNE_NATIVE_DRIVER=off` | Never install or start the on-device runner (iOS) or server (Android). Taps, swipes, typing and OS layout go through axe/adb exactly as before the driver existed. On Android it also force-stops a server left running by an earlier session |

## Native driver

For faster, more reliable OS input the package ships prebuilt on-device drivers; there is nothing to build (`scripts/build-drivers.sh` is only for contributors). On first use it installs, per device:

| Platform | What is installed |
|---|---|
| iOS simulator | The runner app `dev.rneye.runnerUITests.xctrunner`, started as an XCUITest |
| Android | `dev.rneye.server` and `dev.rneye.server.test`. The app also registers an input method, switched on only while typing non-ASCII text and restored to your keyboard afterwards |

If a driver cannot be installed or started, input and layout fall back to axe/adb automatically, and the response names the path that ran. `RNE_NATIVE_DRIVER=off` opts out entirely.

While the Android server is up it holds UiAutomation, so other UiAutomation clients on that device (Appium, `uiautomator dump`) fail until it is stopped (`adb shell am force-stop dev.rneye.server`, or `RNE_NATIVE_DRIVER=off`).

## Privacy

**No telemetry. No accounts. No cloud.** The only network traffic is to localhost (Metro) and local device drivers. This is enforced by an automated test that fails the build if any external URL appears in the source, and another that fails if a license/account/feedback tool ever shows up in the tool surface.

## Limitations

The short version: dev builds only, and the JS path calls handlers rather than performing gestures.

| Limitation | Detail |
|---|---|
| Dev builds only | Requires Metro + Hermes; production builds are unsupported. |
| Single debugger (RN < 0.85) | Hermes allows one CDP client at a time; RN 0.85+ supports multiple. |
| Input path | A JS press calls a handler; it is not a gesture. Native views outside the React tree, system dialogs and permission alerts, Reanimated gestures that run on the UI thread, drag handles and swipeable rows, and momentum scrolling are not reproduced — those need `via: "os"`. `swipe`'s JS path moves a scroll container's offset — it is not a gesture either, so a swipeable row or a pull-to-refresh needs `via: "os"`. Every response names the path it used, so a fallback is never silent. |
| Cold start | Logs/network before `connect` are missed; `reload_app` after connecting captures everything from the next start (it waits for the new runtime and confirms it). Gaps in the log stream are reported. |
| Store access | Reliable `get_state` needs `globalThis.__RNE_STORES__` assigned in the app (falls back to common globals). Accepts either a single store (an object with `getState()`) or a map of named stores (e.g. `{ cart: { getState }, auth: { getState } }`); each store in a map has its own `getState()` called and is exposed under its key. If a store's `getState()` throws, that key reports `{ __rneStoreError: <message> }` instead of app data — the other stores in the map are unaffected. |

<details>
<summary><strong>The full list</strong></summary>

| Limitation | Detail |
|---|---|
| In-app interceptor | The network hooks live in the app, so they outlive the server. Connecting with a newer build replaces them; if an older build left hooks that cannot be removed, `connect` says so and `reload_app` clears them. |
| Screenshots | Inline screenshots are downscaled to 800px JPEG by default (pass `full_res: true` for the native PNG). Compression tries `sips` (macOS), then ImageMagick (`magick`, then `convert`), then `ffmpeg` — whichever is installed first wins, so non-macOS hosts get downscaling too, not just macOS. An inline image (compressed or, with `full_res`/no downscaler available, raw) that would still exceed ~7500px on a side or ~4.5MB base64-encoded is never returned — the call fails with the measured size and how to get the image anyway (`output_path` to save the full file, or drop `full_res`). File output via `output_path` is always native and has no size ceiling. |
| Layout source | `get_layout`/`observe` read element positions from the app's JS runtime when possible (Paper and Fabric, ~80ms for a full screen) and fall back to the native driver or axe/uiautomator; output is marked `(layout: js)` / `(layout: os)` — with the reason when the JS path was skipped — and a `source` param can force either path. |
| Off-screen and hidden elements | Elements scrolled out of the viewport, and those on a screen that is mounted but not on display (an inactive tab, a stack screen below the top, `display:none`), are listed separately and marked. Tapping one is an error, and `expect`/`wait_for` do not treat one as present. Tap points are the centre of the *visible* part of an element, so a control wider than the screen is still hit. |
| Which screen is live | Taken from react-navigation / react-native-screens state (`focused`, the scene index vs the navigator's, `activityState`). An app with a custom navigator that keeps screens mounted without those props may still report hidden screens as visible. |
| Text input | `axe type` (iOS) and `input text` (Android) both send positional key events and are ASCII-only on their own — non-ASCII text on those paths is refused rather than reported as typed (Android's on-device server lifts this, see below). On iOS the *host's* keyboard layout also rewrites what arrives: the keycodes are positional, so under `com.apple.keylayout.RussianWin` the string `cat` reached the field as `сф` — two characters, both wrong, and the tool reported success. `type_text` now refuses the OS path when the host's active layout is not ASCII-safe (naming the layout and the fix), and `verify` (default true) reads the field back to catch anything else. `via: "js"` writes through `onChangeText` and never touches a keyboard, so it is immune to both. On Android, while the on-device server is ready (`(input: os/runner)`), `type_text` types any Unicode through its own keyboard, which is selected for the call and then switched back. `input text` (the `os/adb` fallback) is still ASCII-only and refuses the rest. |
| Touch cost on the iOS simulator without the native driver | Delivering a touch through axe to a foregrounded, busy RN app measured **17–25 s** (worst 29.8 s) on iPhone 17 Pro / iOS 26.2 with axe 1.7.1, while HID typing, hardware buttons and screenshots against the same app in the same state stayed at **0.3–0.6 s**. The cost is per touch event, not per process, so batching does not amortise it (`axe batch`: 3 taps 57 s, 6 taps 117 s). The budgets are split to match — 90 s for touch (`tap`, `swipe`, and iOS `press_key: "back"`, which is an edge swipe), 10 s for keyboard and hardware buttons — and a touch that does exhaust its budget reports whether the screen changed, so a timeout is not left ambiguous. `via: "js"`, `scroll_to`'s JS path, `open_url` and `set_permission` deliver no touches and are unaffected. |
| Error capture | In a dev build LogBox is the `ErrorUtils` global handler: it paints the redbox and swallows the exception, so an app crash never reaches the debugger and a plain CDP listener reports no errors under a full-screen redbox. `connect` chains onto that handler instead of replacing it — the redbox still shows, and `get_errors`, `observe`, `check_state` and `run_flow`'s abort watermark all see the crash. A runtime with no `ErrorUtils` to hook is named as such at connect time rather than silently reporting no errors. Two kinds never reach it: an unhandled promise rejection (it never goes through `ErrorUtils`) and an error caught by the app's own ErrorBoundary. Both still show up in LogBox on screen — `get_errors` names both when it has nothing else to report; check with `screenshot` or `read_screen_text`. |
| Route in `check_state` | Found by walking the React tree for a react-navigation container (react-navigation 6/7, Expo Router). An app that navigates some other way can still expose a ref on `globalThis.__RNE_NAV__` (or set `globalThis.__RNE_ROUTE__`); otherwise the route is `null` with the reason. |
| Profiling | `profile_renders` and `profile_js` need a dev build (DevTools hook, Hermes Profiler domain). `profile_js` stops only when the JS thread yields, so a thread that is blocked for the whole window times out — `sample_cpu` reads the same thread from outside and does not. `sample_cpu` on iOS covers the simulator only (macOS `sample`); `get_fps` UI-thread frames are Android-only. |
| OCR | `read_screen_text` runs Apple Vision on the host: macOS with the Command Line Tools only (other hosts get an error); the first call compiles a small helper (~10–30s, cached per version). It reads the native-resolution screenshot and converts boxes to tap units using the simulator's screen scale (1:1 on Android). OCR lines are text runs, not controls — they carry no press semantics, and confidence below 0.5 is flagged. |

</details>

## Development

```sh
npm install
npm run build        # compile to build/
npm test             # unit tests
npm run dev          # run the server from source
```

- `npm run test:integration` runs the device tests. They need a booted iOS simulator (its udid in `RNE_INTEGRATION_UDID`) or an Android emulator (its serial in `RNE_INTEGRATION_ANDROID_SERIAL`).
- `scripts/build-drivers.sh` rebuilds the native drivers under `native/` (Xcode for iOS; JDK 17+ and the Android SDK for Android). Any change under `native/` changes the driver version.
- `scripts/pack-test.sh` packs the tarball, installs it into a fresh project and checks that the drivers arrive intact and the server answers.

## License

MIT for react-native-eye itself. The native drivers include third-party components under Apache-2.0, BSD and MIT licenses. Attributions are in [NOTICE](NOTICE), the Apache-2.0 text is in [native/LICENSE-APACHE](native/LICENSE-APACHE), and per-driver details are in [native/ios-runner/THIRD_PARTY.md](native/ios-runner/THIRD_PARTY.md) and [native/android-server/THIRD_PARTY.md](native/android-server/THIRD_PARTY.md).
