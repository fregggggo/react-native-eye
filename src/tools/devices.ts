import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry, NEW_RUNTIME_READY_TIMEOUT_MS, type RuntimeSetupOutcome } from "../core/registry.js";
import { deviceContext } from "./context.js";
import { IosDriver } from "../drivers/ios.js";
import { AndroidDriver } from "../drivers/android.js";
import { run } from "../core/exec.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError } from "../core/errors.js";
import type { DeviceDriver } from "../drivers/types.js";

// A string with no scheme is not a deeplink, and both platforms fail on it with
// something unrelated to the real mistake (`simctl openurl` reports an
// LSApplication error; `am start -d example.com` starts nothing and exits 0).
// Which schemes are legal is deliberately NOT checked: a custom app scheme
// (demo://, com.my-app.dev://) is the entire point of this tool. An empty
// string fails the same test.
function assertUrl(url: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url.trim())) {
    throw new UserInputError("Provide a URL with a scheme, e.g. myapp://home or an https:// link.");
  }
}

const APP_READY_TIMEOUT_MS = 4000;

/**
 * Mirrors the wording connect() uses (src/tools/connection.ts) for the same
 * interceptorStatus/errorInterceptorStatus values, so an agent reading either
 * tool's output learns one vocabulary instead of two for the same condition.
 *
 * "unavailable" on the error interceptor is a legitimate, unalarming state —
 * this runtime simply has no ErrorUtils to hook — so, exactly as connect()
 * does, it gets an informational note rather than the "capture may be
 * incomplete, retry" alarm given to "stale" and "failed". Any other
 * non-"ok" value (in practice just "failed" — installInterceptors()'s own
 * evaluate() call throwing, e.g. a CDP hiccup right after reload) gets that
 * alarm: reload_app previously computed this status and silently dropped it,
 * which is the exact "failed capture reports itself as normal" bug this plan
 * exists to close.
 */
function interceptorNotes(conn: { interceptorStatus: unknown; errorInterceptorStatus: unknown }): string {
  let netNote = "";
  if (conn.interceptorStatus === "stale") {
    netNote =
      "\nNote: an older network interceptor is still installed in the running app — requests may be counted twice. Run reload_app to clear it.";
  } else if (conn.interceptorStatus !== "ok") {
    netNote =
      `\nNote: the network interceptor is ${String(conn.interceptorStatus)} — network capture may be incomplete. Try reload_app again.`;
  }
  let errNote = "";
  if (conn.errorInterceptorStatus === "unavailable") {
    errNote =
      "\nNote: this runtime exposes no ErrorUtils — redboxes cannot be captured, so get_errors will only report what the debugger sees. Check get_logs too.";
  } else if (conn.errorInterceptorStatus === "stale") {
    errNote =
      "\nNote: an older error handler from a previous session is still installed — run reload_app to clear it.";
  } else if (conn.errorInterceptorStatus !== "ok") {
    errNote =
      `\nNote: the error interceptor is ${String(conn.errorInterceptorStatus)} — error/redbox capture may be incomplete. Try reload_app again.`;
  }
  return `${netNote}${errNote}`;
}

/**
 * How long reload_app gives the old runtime to go away (or, on a target that
 * announces no contexts, the new one to answer) before it stops watching.
 * Measured: RN 0.83 bridgeless destroys the old context ~0.8 s after Page.reload.
 */
const RELOAD_WAIT_MS = 6000;
/**
 * Once the target has said the old runtime is gone, how long (from the reload
 * request) reload_app waits for the new execution context. Measured on an
 * Android emulator: created ~7.5 s after Page.reload idle, ~10.5 s with the
 * host at load 16 (the bundle load alone took 9.6 s), and the host reached
 * load 25 in the same session — so 6 s never sufficed (field test D35). 30 s is
 * about three times the loaded figure; with the setup wait below the whole
 * call still ends well inside a 60 s MCP tool timeout.
 */
const RELOAD_NEW_RUNTIME_WAIT_MS = 30000;
/**
 * How long reload_app waits on the background (re)install once the new runtime
 * has appeared. It keeps running after the answer either way.
 */
const RELOAD_SETUP_WAIT_MS = NEW_RUNTIME_READY_TIMEOUT_MS + 2000;

/**
 * The answer once a new runtime is confirmed and the interceptors were
 * (re)installed after waiting `readyTimeoutMs` for React.
 */
function reloadedText(
  live: { interceptorStatus: unknown; errorInterceptorStatus: unknown },
  ready: boolean,
  readyTimeoutMs: number,
  how = "new JS runtime confirmed",
): string {
  const notes = interceptorNotes(live);
  if (!ready) {
    // A readiness timeout and a non-"ok" interceptor status land
    // together often — the bundle that was too slow to render is
    // the same bundle that overwrites a hook. This sentence used
    // to assert both hooks were (re)installed regardless, so the
    // note right after it ("the network interceptor is failed")
    // contradicted the clause before it. Name only what actually
    // came back live; `notes` says what happened to the rest.
    const installed = [
      live.interceptorStatus === "ok" ? "network" : null,
      live.errorInterceptorStatus === "ok" ? "error" : null,
    ].filter(Boolean);
    const claim = installed.length
      ? ` — ${installed.join("/")} capture was (re)installed anyway and may be overwritten if the bundle is still initialising.`
      : ", and no capture hook came back live — the notes below say which, and what to do about it.";
    return `App reloaded (${how}), but React did not confirm a renderer within ${readyTimeoutMs}ms${claim}${notes}`;
  }
  // Only what actually came back live is claimed; `notes` covers the rest.
  const back = [
    live.errorInterceptorStatus === "ok" ? "error" : null,
    live.interceptorStatus === "ok" ? "network" : null,
  ].filter(Boolean);
  const capture = back.length ? `; ${back.join(" and ")} capture reinstalled` : "";
  return `App reloaded (${how})${capture}.${notes}`;
}

/** "7.6" under ten seconds, "24" above — precision the measurement has. */
function secs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? s.toFixed(1) : String(Math.round(s));
}

export function registerDeviceTools(
  server: McpServer,
  opts?: {
    drivers?: DeviceDriver[];
    runner?: typeof run;
    /** Test knobs for reload_app's two waits (RELOAD_WAIT_MS, RELOAD_NEW_RUNTIME_WAIT_MS). */
    reloadWaitMs?: number;
    reloadNewRuntimeWaitMs?: number;
  },
): void {
  const drivers = () => opts?.drivers ?? [new IosDriver(), new AndroidDriver()];

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List available iOS simulators and Android devices (booted ones are marked).",
      inputSchema: {},
    },
    async () => {
      try {
        const all = (await Promise.all(drivers().map((d) => d.listDevices().catch(() => [])))).flat();
        if (all.length === 0) return text("No devices found. Boot a simulator/emulator.");
        return text(all.map((d) => `${d.platform} ${d.name} (${d.udid})${d.booted ? " — booted" : ""}`).join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "launch_app",
    {
      title: "Launch app",
      description:
        "Launch an app by bundle id (iOS) / package name (Android) on the active device. Optional: terminate_running to restart a running app, env to pass launch environment variables (iOS only).",
      inputSchema: {
        app_id: z.string(),
        terminate_running: z.boolean().optional(),
        env: z.record(z.string()).optional(),
        device: z.string().optional(),
      },
    },
    async ({ app_id, terminate_running, env, device }) => {
      try {
        const { driver, udid } = await deviceContext({ ...opts, device });
        await driver.launchApp(udid, app_id, { terminateRunning: terminate_running, env });
        return text(`Launched ${app_id}.`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "install_app",
    {
      title: "Install app",
      description: "Install an app bundle on the active device (.app/.ipa on iOS, .apk on Android).",
      inputSchema: { app_path: z.string(), device: z.string().optional() },
    },
    async ({ app_path, device }) => {
      try {
        if (!existsSync(app_path)) throw new UserInputError(`Path does not exist: ${app_path}`);
        const { driver, udid } = await deviceContext({ ...opts, device });
        await driver.installApp(udid, app_path);
        return text(`Installed ${app_path}.`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "open_simulator",
    {
      title: "Open Simulator",
      description: "Open the iOS Simulator app (macOS only).",
      inputSchema: {},
    },
    async () => {
      try {
        if (process.platform !== "darwin") throw new UserInputError("open_simulator is only available on macOS.");
        await (opts?.runner ?? run)("open", ["-a", "Simulator"]);
        return text("Opened Simulator.");
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "open_url",
    {
      title: "Open URL",
      description:
        "Open a deeplink or universal link on the active device (myapp://screen, https://…). Touch-free: it delivers no touch event, so it is unaffected by slow touch delivery and is usually the cheapest way to reach a screen.",
      inputSchema: { url: z.string(), device: z.string().optional() },
    },
    async ({ url, device }) => {
      try {
        assertUrl(url);
        const { driver, udid } = await deviceContext({ ...opts, device });
        if (!driver.openUrl) throw new UserInputError(`open_url is not supported on ${driver.platform}.`);
        await driver.openUrl(udid, url);
        return text(`Opened ${url}.`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "set_permission",
    {
      title: "Set permission",
      description:
        "Grant, revoke or reset one privacy permission for an app, so the system alert never appears. iOS services: camera, photos, photos-add, location, location-always, contacts, contacts-limited, microphone, motion, calendar, reminders, media-library, siri, all. Android services: camera, microphone, photos, location, contacts, notifications. app_id defaults to the connected app.",
      inputSchema: {
        service: z.string(),
        status: z.enum(["grant", "revoke", "reset"]),
        app_id: z.string().optional(),
        device: z.string().optional(),
      },
    },
    async ({ service, status, app_id, device }) => {
      try {
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        if (!driver.setPermission) {
          throw new UserInputError(`set_permission is not supported on ${driver.platform}.`);
        }
        // The CDP target reports the bundle id / package name of the app being
        // debugged; reuse it rather than making the caller repeat it.
        const appId = app_id ?? conn?.meta.appId;
        if (!appId) throw new UserInputError("No app is connected — pass app_id.");
        await driver.setPermission(udid, appId, service, status);
        if (driver.platform === "android" && status === "reset") {
          return text(
            `Reset runtime permissions. Note: Android's \`pm reset-permissions\` resets every app on the device, not just ${appId}.`,
          );
        }
        const verb = status === "grant" ? "Granted" : status === "revoke" ? "Revoked" : "Reset";
        // Several services are only read at process start, so a change made while
        // the app is running looks like it did nothing. Say so here rather than
        // leaving the caller to guess.
        return text(
          `${verb} ${service} for ${appId}. Some services are only re-read at launch — if the app does not see the change, relaunch it with launch_app({ app_id: "${appId}", terminate_running: true }).`,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "reload_app",
    {
      title: "Reload app",
      description:
        "Reload the JS bundle and wait for the new runtime (captures cold-start logs/network on the next run).",
      inputSchema: {},
    },
    async () => {
      try {
        const registry = getRegistry();
        const conn = await registry.ensure();
        // Prove the reload happened instead of reporting success unconditionally.
        // The proof is runtime identity: the target announcing a new execution
        // context. A slow device keeps the old runtime answering while it fetches
        // the new bundle, so "the old one went quiet within 6s" was a guess that
        // said "may not have reloaded" about reloads that happened (field test
        // D26). The sentinel global stays as the fallback for a target that
        // announces no contexts, and for a socket that drops on reload.
        const generation = conn.runtimeGeneration;
        const sentinel = `__RNE_SENTINEL_${Math.floor(Math.random() * 1e9)}__`;
        await conn.evaluate(`globalThis.${sentinel} = 1`).catch(() => {});
        await conn.requestReload();
        conn.logs.markGap();

        const started = Date.now();
        const waitMs = opts?.reloadWaitMs ?? RELOAD_WAIT_MS;
        const aliveDeadline = started + waitMs;
        const goneDeadline = started + (opts?.reloadNewRuntimeWaitMs ?? RELOAD_NEW_RUNTIME_WAIT_MS);

        // The connection saw the new execution context and is already
        // (re)installing into it. Wait for that rather than racing it, but not
        // forever: it keeps going in the background after this answer.
        const confirmedByIdentity = async () => {
          const outcome = await Promise.race<RuntimeSetupOutcome | undefined>([
            conn.runtimeSetup,
            new Promise((r) => setTimeout(() => r(undefined), RELOAD_SETUP_WAIT_MS).unref?.()),
          ]);
          const how = `new JS runtime after ${secs((conn.runtimeRestartedAt ?? Date.now()) - started)}s`;
          if (!outcome) {
            return text(
              `App reloaded (${how}), but it is still starting — capture is being installed in it in the background as it comes up.`,
            );
          }
          return text(reloadedText(conn, outcome.ready, outcome.readyTimeoutMs, how));
        };
        const replaced = () => conn.runtimeGeneration !== generation && conn.runtimeSetup !== undefined;

        let lastProbe: unknown;
        for (;;) {
          await new Promise((r) => setTimeout(r, 250));
          if (replaced()) return await confirmedByIdentity();
          if (conn.connected && conn.runtimeGone) {
            // The target said the old runtime is gone. There is nothing to
            // probe until it announces the next one — which on a real device
            // takes a whole bundle load, well past the window below.
            if (Date.now() < goneDeadline) continue;
            return text(
              `Reload requested: the old JS runtime is gone, but the new one has not started yet after ${secs(Date.now() - started)}s — ` +
                `the app is probably still loading its bundle. Error and network capture will be reinstalled automatically when it does; ` +
                `calls made meanwhile wait for it briefly.`,
            );
          }
          if (Date.now() >= aliveDeadline) break;
          lastProbe = await registry
            .ensure()
            .then((c) => c.evaluate(`typeof globalThis.${sentinel}`))
            .catch(() => undefined);
          if (lastProbe === "undefined") {
            // The probe can have waited through the gap and run in the new
            // runtime; if the target announced that runtime, identity decides.
            if (replaced()) return await confirmedByIdentity();
            const live = registry.active_or_null;
            // The sentinel disappears the instant the new runtime exists — long
            // before the bundle has installed its own fetch and rendered. Hooks
            // put on at that moment get overwritten and the flags then claim
            // they are installed (field test D14), so wait for React to have a
            // renderer registered before installing.
            if (live) {
              // A target that announces contexts reports this runtime itself
              // (its own setup is or will be running); otherwise this is the
              // only place the connection learns its runtime was replaced.
              if (live !== conn || !live.tracksRuntimes) live.markRuntimeReplaced();
              const ready = await live.waitForAppReady(APP_READY_TIMEOUT_MS);
              await live.installInterceptors();
              return text(reloadedText(live, ready, APP_READY_TIMEOUT_MS));
            }
            return text("App reloaded (new JS runtime confirmed).");
          }
        }
        const waited = secs(Date.now() - started);
        const tracked = conn.connected && conn.tracksRuntimes;
        if (lastProbe !== "number") {
          // Nothing answered the last probe, so "the old runtime is still
          // answering" would be a guess — and on a reloading app a wrong one.
          return text(
            `Reload requested, but no JS runtime is answering after ${waited}s — the app is probably still loading its bundle. ` +
              (tracked
                ? `Capture is reinstalled automatically when the new runtime starts; retry in a few seconds.`
                : `get_errors and get_network reinstall capture in the new runtime when they run; retry in a few seconds.`),
          );
        }
        if (tracked) {
          return text(
            `Reload requested, but the old JS runtime is still answering after ${waited}s — the new one has not started yet ` +
              `(a slow device can take longer to fetch and load the bundle). When it starts, capture is reinstalled in it ` +
              `automatically; check with observe or get_logs. If no new runtime ever appears, the reload did not happen — run reload_app again.`,
          );
        }
        return text(
          `Reload requested, but the old JS runtime is still answering after ${waited}s — it may not have reloaded. ` +
            `If it is just slow, get_errors and get_network reinstall capture in the new runtime when they run.`,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
