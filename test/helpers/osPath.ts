import type { OsPath, RawElement } from "../../src/drivers/types.js";

/**
 * What the real drivers return after T2: IosDriver always `axe`, AndroidDriver
 * always `adb`. Fakes return these so dispatch can format a marker. A fake that
 * returns undefined makes osMarker throw on `os.path`, which is the point:
 * a driver that cannot say which path it used is a broken driver.
 */
export const AXE: OsPath = { path: "axe" };
export const ADB: OsPath = { path: "adb" };
export const RUNNER: OsPath = { path: "runner" };

/** A rawLayout result for fakes that serve OS layouts. */
export function axeLayout(els: RawElement[]): { els: RawElement[]; os: OsPath } {
  return { els, os: AXE };
}
