import { IosDriver } from "./ios.js";
import { AndroidDriver } from "./android.js";
import type { DeviceDriver, DeviceId } from "./types.js";
import { DriverError, UserInputError } from "../core/errors.js";

export type ResolvedDevice = { driver: DeviceDriver; udid: string; name: string };

export type DriverOpts = {
  drivers?: DeviceDriver[];
  /** Explicit udid or device-name substring from the caller. */
  device?: string;
  /** Device the CDP target reports (Metro sends `deviceName`) — keeps taps on the device being debugged. */
  boundTo?: string;
};

function label(d: DeviceId): string {
  return `${d.platform} ${d.name} (${d.udid})`;
}

/** `android sdk_gphone64_arm64 (emulator-5554)` — how every device error names a device. */
export const deviceLabel = label;

/**
 * Metro and the device tools do not agree on a device's name: Metro sends
 * "sdk_gphone64_arm64 - 16 - API 36" while `adb devices -l` reports the bare
 * model. Strict equality therefore never matched on Android and the whole
 * binding mechanism was dead there (field test D20).
 */
export function normalizeDeviceName(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

// The connection and the device used to be chosen independently: the CDP target
// came from a Metro port while taps went to whichever simulator happened to be
// listed first. With two devices booted that silently drove the wrong one, so a
// device is now picked from (in order) an explicit argument, the device the
// debugged app is actually running on, and finally the single booted device.
export async function activeDriver(overrides?: DriverOpts): Promise<ResolvedDevice> {
  const drivers = overrides?.drivers ?? [new IosDriver(), new AndroidDriver()];
  const checked: string[] = [];
  const all: { driver: DeviceDriver; device: DeviceId }[] = [];

  for (const driver of drivers) {
    let devices: DeviceId[];
    try {
      devices = await driver.listDevices();
    } catch {
      checked.push(`${driver.platform} (driver unavailable)`);
      continue;
    }
    const booted = devices.filter((d) => d.booted);
    checked.push(`${driver.platform}: ${devices.length} device(s), ${booted.length} booted`);
    for (const device of devices) all.push({ driver, device });
  }

  const booted = all.filter((e) => e.device.booted);

  if (overrides?.device) {
    const needle = overrides.device.toLowerCase();
    const matches = all.filter(
      (e) => e.device.udid.toLowerCase() === needle || e.device.name.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      throw new UserInputError(
        `No device matching "${overrides.device}". Available: ${all.map((e) => label(e.device)).join("; ") || "none"}.`,
      );
    }
    if (matches.length > 1) {
      throw new UserInputError(
        `"${overrides.device}" matches ${matches.length} devices: ${matches
          .map((e) => label(e.device))
          .join("; ")}. Pass the udid.`,
      );
    }
    const hit = matches[0];
    if (!hit.device.booted) throw new DriverError(`${label(hit.device)} is not booted.`);
    return { driver: hit.driver, udid: hit.device.udid, name: hit.device.name };
  }

  // Set only when boundTo ties between two-or-more booted devices, so the
  // fallthrough below can name exactly the devices that tied — a device that
  // never matched must not be listed alongside ones that did (it reads as a
  // plausible pick when it never was one).
  let boundToTie: { requested: string; matches: { driver: DeviceDriver; device: DeviceId }[] } | undefined;

  if (overrides?.boundTo) {
    const needle = normalizeDeviceName(overrides.boundTo);
    const named = booted.map((e) => ({ e, n: normalizeDeviceName(e.device.name) }));
    const exact = named.filter((x) => x.n === needle);
    // Containment in either direction, because either side may be the decorated
    // one. Ambiguity is never resolved by guessing: two containment matches fall
    // through to the normal "pass device:" refusal below.
    const contained = named.filter((x) => x.n.length > 0 && (needle.includes(x.n) || x.n.includes(needle)));
    const hit = exact.length === 1 ? exact[0] : contained.length === 1 ? contained[0] : undefined;
    if (hit) return { driver: hit.e.driver, udid: hit.e.device.udid, name: hit.e.device.name };
    if (contained.length > 1) boundToTie = { requested: overrides.boundTo, matches: contained.map((x) => x.e) };
  }

  if (booted.length === 1) {
    const hit = booted[0];
    return { driver: hit.driver, udid: hit.device.udid, name: hit.device.name };
  }
  if (booted.length > 1) {
    if (boundToTie) {
      throw new UserInputError(
        `"${boundToTie.requested}" is ambiguous — it matches ${boundToTie.matches.length} booted devices: ${boundToTie.matches
          .map((e) => label(e.device))
          .join("; ")}. Pass a more specific name or an explicit device id.`,
      );
    }
    // boundTo (the Metro-reported device name) may be why nothing was returned
    // above because it matched none of the booted devices — there is no tie
    // here, so the full booted set genuinely is the candidate list.
    const request = overrides?.boundTo ? `; "${overrides.boundTo}" doesn't uniquely match one of them` : "";
    throw new UserInputError(
      `${booted.length} booted devices${request} — pass device: ${booted.map((e) => label(e.device)).join("; ")}.`,
    );
  }
  throw new DriverError(`No booted device found. Checked — ${checked.join("; ")}.`);
}

export type DeviceById = {
  driver: DeviceDriver;
  device: DeviceId;
  /** Booted devices whose normalised name equals this one's (itself included when booted). */
  sameName: DeviceId[];
};

/**
 * The device whose simulator UDID / adb serial is exactly `id` (case ignored),
 * booted or not; undefined when `id` is no device's id — a name, most likely.
 * For connect (field test 3 D30): Metro knows devices by name only, so an id
 * has to be turned into that device's name before a target can be matched. A
 * driver that cannot list its devices is skipped.
 */
export async function deviceById(id: string, drivers?: DeviceDriver[]): Promise<DeviceById | undefined> {
  const needle = id.toLowerCase();
  const all: { driver: DeviceDriver; device: DeviceId }[] = [];
  for (const driver of drivers ?? [new IosDriver(), new AndroidDriver()]) {
    try {
      for (const device of await driver.listDevices()) all.push({ driver, device });
    } catch {
      /* driver unavailable */
    }
  }
  const hit = all.find((e) => e.device.udid.toLowerCase() === needle);
  if (!hit) return undefined;
  const name = normalizeDeviceName(hit.device.name);
  const sameName = all.filter((e) => e.device.booted && normalizeDeviceName(e.device.name) === name).map((e) => e.device);
  return { driver: hit.driver, device: hit.device, sameName };
}
