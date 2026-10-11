import { getRegistry, type Connection } from "../core/registry.js";
import { activeDriver, normalizeDeviceName, type DriverOpts, type ResolvedDevice } from "../drivers/resolve.js";
import { UserInputError } from "../core/errors.js";

export type ToolCtx = ResolvedDevice & { conn?: Connection };

// Driving the device (tap, screenshot, OS layout) needs simctl/axe/adb, not a
// debugger: requiring a CDP connection for those made a release build or an app
// with Metro down completely untouchable. The connection is still looked up when
// present — it names the device the app actually runs on, and unlocks the fast
// JS layout path.
/**
 * False only when the caller named a device and the connection is known to be
 * another one. The JS runtime behind `conn` is one app on one device: its
 * layout, presses and errors say nothing about any other device, and using it
 * for one made a call for the Android emulator read (and report as Android's)
 * the iPhone app's screen. Metro decorates names ("sdk_gphone64_arm64 - 16 -
 * API 36"), hence containment either way, as device binding does. With no name
 * from Metro there is nothing to compare.
 */
function sameDevice(conn: Connection, resolved: ResolvedDevice, explicit: string | undefined): boolean {
  if (!explicit || !conn.meta.deviceName) return true;
  const a = normalizeDeviceName(conn.meta.deviceName);
  const b = normalizeDeviceName(resolved.name);
  return a.length === 0 || b.length === 0 || a.includes(b) || b.includes(a);
}

export async function deviceContext(opts?: DriverOpts & { device?: string }): Promise<ToolCtx> {
  const conn = await getRegistry().optional();
  const resolved = await activeDriver({ ...opts, boundTo: conn?.meta.deviceName });
  return { ...resolved, conn: conn && sameDevice(conn, resolved, opts?.device) ? conn : undefined };
}

/** For tools that genuinely need the app runtime; reconnects if the socket dropped. */
export async function runtimeContext(opts?: DriverOpts & { device?: string }): Promise<ToolCtx & { conn: Connection }> {
  const conn = await getRegistry().ensure();
  const resolved = await activeDriver({ ...opts, boundTo: conn.meta.deviceName });
  if (!sameDevice(conn, resolved, opts?.device)) {
    throw new UserInputError(
      `The connected app runs on ${conn.meta.deviceName}, not on ${resolved.name} (${resolved.udid}) — ` +
        `run connect with device: "${resolved.udid}" first, or drop device: to use the connected one.`,
    );
  }
  return { ...resolved, conn };
}
