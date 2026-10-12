import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text } from "../core/format.js";
import { ConnectionError, DriverError, toToolError } from "../core/errors.js";
import { activeDriver, deviceById, deviceLabel, normalizeDeviceName } from "../drivers/resolve.js";
import type { DeviceDriver } from "../drivers/types.js";
import { IOS_START_WAIT_MS } from "../drivers/ios.js";
import { sharedPool, type NativePool, type PoolEntryView } from "../native/pool.js";
import { androidArtifact, iosArtifact } from "../native/artifacts.js";

export type ConnectionToolOpts = {
  drivers?: DeviceDriver[];
  pool?: Pick<NativePool, "warm" | "view">;
  /**
   * How long connect waits for the warm-up to settle. Long enough for a live
   * runner of our version to be found (launchctl + lsof + one /status), far too
   * short for a real start — which is what makes "ready (reused)" honest.
   */
  warmPeekMs?: number;
  /**
   * The driver build's version (G14), from build/drivers/manifest.json. A
   * runner counts as ready only when its /status answers exactly this
   * version, so it is also the version of a ready or reused runner.
   */
  driverVersion?: (platform: "ios" | "android") => string | undefined;
};

const WARM_PEEK_MS = 1500;

function manifestVersion(platform: "ios" | "android"): string | undefined {
  try {
    return (platform === "ios" ? iosArtifact() : androidArtifact())?.version;
  } catch {
    return undefined;
  }
}

/**
 * The next step for a pool failure reason, so "unavailable" is never a dead end.
 * Empty when the reason already carries one: the iOS runner's and the Android
 * server's DriverErrors end in their own recommendation ("Run
 * scripts/build-drivers.sh …", "… retried in 5 minutes. The server's own log: …",
 * "… until then input goes through adb."), and saying it twice is noise.
 */
export function nativeAdvice(reason: string, platform: "ios" | "android" = "ios"): string {
  if (/^disabled\b/.test(reason)) return "Unset RNE_NATIVE_DRIVER to turn it back on.";
  if (/Run scripts\/build-drivers\.sh|retried in 5 minutes|until then input goes through/.test(reason)) return "";
  if (/^unsupported: /.test(reason)) {
    return platform === "android"
      ? "This Android version lacks something the server needs; input goes through adb, and the server is retried after 5 minutes."
      : "This Xcode/iOS lacks a private API the runner needs; input goes through axe, and the runner is retried after 5 minutes.";
  }
  return platform === "android"
    ? "Taps, swipes and layout use adb meanwhile; the server retries by itself after 5 minutes."
    : "Taps, swipes and layout use axe meanwhile; the runner retries by itself after 5 minutes.";
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One line about the on-device driver for connect's answer. Never throws and
 * never waits for a start: connect must succeed whatever the driver does.
 */
export async function nativeDriverLine(
  target: { device?: string; boundTo?: string; appId?: string },
  opts: ConnectionToolOpts = {},
): Promise<string> {
  let platform: "ios" | "android";
  let udid: string;
  try {
    const resolved = await activeDriver({ drivers: opts.drivers, device: target.device, boundTo: target.boundTo });
    platform = resolved.driver.platform;
    udid = resolved.udid;
  } catch (err) {
    return `native driver: not started — ${messageOf(err)}`;
  }
  const pool = opts.pool ?? sharedPool();
  const unavailable = (reason = "unknown reason") => {
    const r = reason.trim();
    const advice = nativeAdvice(r, platform);
    return `native driver: unavailable — ${/[.!?]$/.test(r) ? r : `${r}.`}${advice ? ` ${advice}` : ""}`;
  };

  const version = (opts.driverVersion ?? manifestVersion)(platform);
  // `ready (reused, 0.0.1-6ee5255e)`, `starting in background (0.0.1-6ee5255e)`.
  const tag = (...parts: string[]) => {
    const all = version ? [...parts, version] : parts;
    return all.length ? ` (${all.join(", ")})` : "";
  };

  // Already ready in this process: nothing to start.
  if (pool.view(platform, udid)?.state === "ready") return `native driver: ready${tag("reused")}`;

  // Not awaited beyond the peek: warm() keeps going in the background.
  const started = pool.warm(platform, udid, { foreground: target.appId }).then(
    (v) => v,
    (err: unknown): PoolEntryView => ({ state: "failed", reason: messageOf(err) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const peek = await Promise.race([
    started,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.warmPeekMs ?? WARM_PEEK_MS);
    }),
  ]);
  clearTimeout(timer);
  if (peek?.state === "ready") return `native driver: ready${peek.via === "reused" ? tag("reused") : tag()}`;
  if (peek?.state === "failed") return unavailable(peek.reason);
  const now = pool.view(platform, udid);
  const state = now?.state === "dead" ? "restarting in background" : "starting in background";
  // iOS OS gestures and layout wait for the start (the runner is in front of
  // the app meanwhile); Android ones use adb until the server is up.
  return platform === "ios"
    ? `native driver: ${state}${tag()} — OS taps, swipes and layout wait for it (up to ${IOS_START_WAIT_MS / 1000} s), then use axe.`
    : `native driver: ${state}${tag()} — until it is ready, taps, swipes and layout use adb.`;
}

/**
 * connect's `device` given as an adb serial or a simulator UDID (field test 3
 * D30). Metro names its targets by device name only, so the id is resolved to
 * its device and the target is matched by that device's name, normalised as in
 * D20 (Metro: "sdk_gphone64_arm64 - 16 - API 36", adb: "sdk_gphone64_arm64").
 * Returns undefined when `device` is not a device id — it is then a name and
 * goes to the registry as before. `metroDevice`: Metro's own spelling of the
 * device name, for the registry's filter; undefined when Metro's targets carry
 * no device name to filter by.
 */
export async function resolveConnectDevice(
  device: string,
  port: number | undefined,
  opts: ConnectionToolOpts = {},
): Promise<{ udid: string; metroDevice?: string; note?: string } | undefined> {
  const hit = await deviceById(device, opts.drivers);
  if (!hit) return undefined;
  const label = deviceLabel(hit.device);
  if (!hit.device.booted) throw new DriverError(`${label} is not booted.`);
  const udid = hit.device.udid;
  const twins = hit.sameName;
  const note =
    twins.length > 1
      ? `Note: ${twins.length} booted devices are named "${hit.device.name}" (${twins.map((d) => d.udid).join(", ")}) — ` +
        `Metro tells targets apart by device name only, so this JS target may be running on any of them; device input goes to ${udid}.`
      : undefined;

  const targets = await getRegistry().listTargets(port ? { ports: [port] } : undefined);
  const names = [...new Set(targets.map((t) => t.target.deviceName).filter((n): n is string => !!n))];
  if (names.length === 0) return { udid, note };
  const want = normalizeDeviceName(hit.device.name);
  const named = names.map((n) => ({ n, norm: normalizeDeviceName(n) }));
  const exact = named.filter((x) => x.norm === want);
  // Containment in either direction: either side may be the decorated one.
  const contained = named.filter((x) => x.norm.length > 0 && (x.norm.includes(want) || want.includes(x.norm)));
  const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");
  const where = port ? ` on port ${port}` : "";
  if (exact.length === 1) return { udid, metroDevice: exact[0].n, note };
  if (contained.length === 1) return { udid, metroDevice: contained[0].n, note };
  if (contained.length > 1) {
    throw new ConnectionError(
      `${label} matches several device names Metro reports${where}: ${quoted(contained.map((x) => x.n))} — pass a target_id from list_targets`,
    );
  }
  throw new ConnectionError(
    `no React Native target on ${label}${where} — Metro's targets are on ${quoted(names)}. Start (or reload) the app on that device, then retry`,
  );
}

export function registerConnectionTools(server: McpServer, opts: ConnectionToolOpts = {}): void {
  server.registerTool(
    "connect",
    {
      title: "Connect",
      description:
        "Connect to a running React Native app via Metro. Optionally pass a port, a target_id from list_targets, or a device name — otherwise standard ports are scanned and the app's JS runtime is picked.",
      inputSchema: {
        port: z.number().int().positive().optional(),
        target_id: z.string().optional(),
        device: z.string().optional(),
      },
    },
    async ({ port, target_id, device }) => {
      try {
        // An adb serial / simulator UDID, like every device tool accepts (D30).
        const picked = device ? await resolveConnectDevice(device, port, opts) : undefined;
        const conn = await getRegistry().connect({
          port,
          targetId: target_id,
          device: picked ? picked.metroDevice : device,
        });
        const where = conn.meta.deviceName ? ` on ${conn.meta.deviceName}` : "";
        const stale =
          conn.interceptorStatus === "stale"
            ? "\nNote: an older network interceptor is still installed in the running app — requests may be counted twice. Run reload_app to clear it."
            : "";
        // A redbox is raised through ErrorUtils and swallowed by LogBox, so
        // without that hook get_errors cannot see the app crash at all. Silence
        // here would read as "no errors" for the rest of the session.
        const errHook =
          conn.errorInterceptorStatus === "unavailable"
            ? "\nNote: this runtime exposes no ErrorUtils — redboxes cannot be captured, so get_errors will only report what the debugger sees. Check get_logs too."
            : conn.errorInterceptorStatus === "stale"
              ? "\nNote: an older error handler from a previous session is still installed — run reload_app to clear it."
              : "";
        // Warm the on-device runner for the device this app runs on; the
        // resolution is the same one every device tool makes, so the runner
        // that warms is the one the next tap uses.
        const native = await nativeDriverLine({ device: picked?.udid ?? device, boundTo: conn.meta.deviceName, appId: conn.meta.appId }, opts);
        const twins = picked?.note ? `\n${picked.note}` : "";
        return text(
          `Connected to "${conn.meta.title}"${where} (port ${conn.meta.port}, target ${conn.meta.targetId}).${stale}${errHook}${twins}\n${native}`,
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "list_targets",
    {
      title: "List targets",
      description:
        "List every debuggable React Native target Metro exposes (a device can have several: the JS runtime, the UI page, stale pages from earlier reloads). Pass a target_id to connect.",
      inputSchema: {},
    },
    async () => {
      try {
        const registry = getRegistry();
        const targets = await registry.listTargets();
        if (targets.length === 0) {
          // "No Metro instances found" was wrong whenever Metro was up without an
          // attached app — that sends the user off to restart a running bundler.
          const idle = await registry.listMetroWithoutTargets();
          if (idle.length > 0) {
            return text(
              `Metro is running on port ${idle.join(", ")}, but no app is attached to it. Start or reload your app, then retry.`,
            );
          }
          return text("No Metro instances found on the standard ports. Start Metro and your app, then retry.");
        }
        const lines = targets.map(
          (t) =>
            `port ${t.port}: "${t.target.title}"${t.target.deviceName ? ` [${t.target.deviceName}]` : ""}` +
            `${t.target.description ? ` — ${t.target.description}` : ""} (${t.target.id})`,
        );
        return text(lines.join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
