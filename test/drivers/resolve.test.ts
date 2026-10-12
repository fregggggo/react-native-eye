import { describe, it, expect } from "vitest";
import { activeDriver, deviceById } from "../../src/drivers/resolve.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

function fakeDriver(platform: "ios" | "android", booted: boolean): DeviceDriver {
  return {
    platform,
    listDevices: async () => (booted ? [{ platform, udid: `${platform}-1`, name: "x", booted: true }] : []),
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () => axeLayout([]),
    tapXY: async () => AXE,
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
  };
}

describe("activeDriver", () => {
  it("picks the platform with a booted device", async () => {
    const res = await activeDriver({ drivers: [fakeDriver("ios", false), fakeDriver("android", true)] });
    expect(res.driver.platform).toBe("android");
    expect(res.udid).toBe("android-1");
  });

  it("throws DriverError when nothing booted", async () => {
    await expect(
      activeDriver({ drivers: [fakeDriver("ios", false), fakeDriver("android", false)] }),
    ).rejects.toThrow(/no booted/i);
  });
});

function multiDriver(devices: { udid: string; name: string; booted: boolean }[]): DeviceDriver {
  return { ...fakeDriver("ios", false), listDevices: async () => devices.map((d) => ({ platform: "ios" as const, ...d })) };
}

describe("activeDriver device selection", () => {
  const two = multiDriver([
    { udid: "AAA", name: "iPhone 17 Pro Max", booted: true },
    { udid: "BBB", name: "iPhone SE", booted: true },
  ]);

  it("refuses to guess between two booted devices", async () => {
    // Silently taking the first is how taps ended up on the wrong simulator.
    await expect(activeDriver({ drivers: [two] })).rejects.toThrow(/2 booted devices — pass device/);
  });

  it("binds to the device the debugged app runs on", async () => {
    const res = await activeDriver({ drivers: [two], boundTo: "iPhone SE" });
    expect(res.udid).toBe("BBB");
  });

  it("accepts an explicit udid", async () => {
    expect((await activeDriver({ drivers: [two], device: "AAA" })).udid).toBe("AAA");
  });

  it("accepts a name substring", async () => {
    expect((await activeDriver({ drivers: [two], device: "SE" })).udid).toBe("BBB");
  });

  it("reports an ambiguous name instead of picking one", async () => {
    await expect(activeDriver({ drivers: [two], device: "iPhone" })).rejects.toThrow(/matches 2 devices/);
  });

  it("lists what is available when the requested device is unknown", async () => {
    await expect(activeDriver({ drivers: [two], device: "Pixel" })).rejects.toThrow(/No device matching "Pixel"/);
  });

  it("says so when the requested device is not booted", async () => {
    const d = multiDriver([{ udid: "CCC", name: "iPad", booted: false }]);
    await expect(activeDriver({ drivers: [d], device: "iPad" })).rejects.toThrow(/not booted/i);
  });

  it("binds to the Metro device name even though adb reports a shorter one", async () => {
    const ios = multiDriver([{ udid: "IOS-1", name: "iPhone 17 Pro", booted: true }]);
    const android: DeviceDriver = {
      ...fakeDriver("android", false),
      listDevices: async () => [
        { platform: "android" as const, udid: "emulator-5556", name: "sdk_gphone64_arm64", booted: true },
      ],
    };
    // Field test D20: Metro decorates the name, adb reports the bare model, and
    // strict equality meant boundTo never matched on Android.
    const res = await activeDriver({ drivers: [ios, android], boundTo: "sdk_gphone64_arm64 - 16 - API 36" });
    expect(res.udid).toBe("emulator-5556");
  });

  it("prefers the exact name when one booted device's name is a prefix of another's", async () => {
    const ios = multiDriver([
      { udid: "PRO", name: "iPhone 17 Pro", booted: true },
      { udid: "MAX", name: "iPhone 17 Pro Max", booted: true },
    ]);
    const res = await activeDriver({ drivers: [ios], boundTo: "iPhone 17 Pro" });
    expect(res.udid).toBe("PRO");
  });

  it("still refuses to guess when the name matches two devices equally", async () => {
    const ios = multiDriver([
      { udid: "A", name: "iPhone 17 Pro Max", booted: true },
      { udid: "B", name: "iPhone 17 Pro Ultra", booted: true },
    ]);
    await expect(activeDriver({ drivers: [ios], boundTo: "iPhone 17 Pro" })).rejects.toThrow(/booted devices/);
  });

  it("names the boundTo request and the candidates when it matches none of the booted devices", async () => {
    const ios = multiDriver([
      { udid: "A", name: "iPhone 17 Pro", booted: true },
      { udid: "B", name: "iPhone SE", booted: true },
    ]);
    let error: Error | undefined;
    try {
      await activeDriver({ drivers: [ios], boundTo: "Pixel 9" });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('"Pixel 9"');
    expect(error?.message).toContain("iPhone 17 Pro");
    expect(error?.message).toContain("iPhone SE");
  });

  it("names the boundTo request and the candidates when it ties between two booted devices", async () => {
    const ios = multiDriver([
      { udid: "A", name: "iPhone 17 Pro Max", booted: true },
      { udid: "B", name: "iPhone 17 Pro Ultra", booted: true },
    ]);
    let error: Error | undefined;
    try {
      await activeDriver({ drivers: [ios], boundTo: "iPhone 17 Pro" });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('"iPhone 17 Pro"');
    expect(error?.message).toContain("iPhone 17 Pro Max");
    expect(error?.message).toContain("iPhone 17 Pro Ultra");
  });

  it("names only the devices that tied, not every booted device, when boundTo ties between two of three", async () => {
    const ios = multiDriver([
      { udid: "A", name: "iPhone 17 Pro Max", booted: true },
      { udid: "B", name: "iPhone 17 Pro Ultra", booted: true },
      { udid: "C", name: "iPhone SE", booted: true },
    ]);
    let error: Error | undefined;
    try {
      await activeDriver({ drivers: [ios], boundTo: "iPhone 17 Pro" });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('"iPhone 17 Pro"');
    expect(error?.message).toContain("iPhone 17 Pro Max");
    expect(error?.message).toContain("iPhone 17 Pro Ultra");
    expect(error?.message).not.toContain("iPhone SE");
  });
});

describe("deviceById (D30)", () => {
  const listing = (platform: "ios" | "android", devices: [udid: string, name: string, booted?: boolean][]) =>
    ({
      platform,
      listDevices: async () => devices.map(([udid, name, booted = true]) => ({ platform, udid, name, booted })),
    }) as unknown as DeviceDriver;
  const broken = { platform: "android", listDevices: async () => Promise.reject(new Error("adb not found")) } as unknown as DeviceDriver;

  it("finds a device by exact udid or serial, case ignored, booted or not — never by name", async () => {
    const drivers = [listing("ios", [["ABCD-1", "iPhone 17 Pro"], ["ABCD-2", "iPhone 16e", false]]), listing("android", [["emulator-5554", "sdk_gphone64_arm64"]])];
    expect((await deviceById("EMULATOR-5554", drivers))?.device).toMatchObject({ platform: "android", udid: "emulator-5554" });
    expect((await deviceById("abcd-2", drivers))?.device).toMatchObject({ udid: "ABCD-2", booted: false });
    expect(await deviceById("iPhone 17 Pro", drivers)).toBeUndefined();
    expect(await deviceById("emulator-555", drivers)).toBeUndefined();
  });

  it("reports the booted devices sharing the name, and skips a driver that cannot list", async () => {
    const drivers = [broken, listing("ios", [["S1", "iPhone 17 Pro"], ["S2", "iPhone 17 Pro"], ["S3", "iPhone 17 Pro", false], ["S4", "iPhone 16e"]])];
    const hit = await deviceById("S2", drivers);
    expect(hit?.driver.platform).toBe("ios");
    expect(hit?.sameName.map((d) => d.udid)).toEqual(["S1", "S2"]);
    expect((await deviceById("S4", drivers))?.sameName.map((d) => d.udid)).toEqual(["S4"]);
  });
});

// connect with an explicit id among same-named devices (two emulators of one
// image): Metro's name ties, the id the connection carries does not.
describe("activeDriver boundId", () => {
  const twins = multiDriver([
    { udid: "SIM-1", name: "iPhone 17 Pro", booted: true },
    { udid: "SIM-2", name: "iPhone 17 Pro", booted: true },
  ]);

  it("picks the bound device by id where the bound name is ambiguous", async () => {
    const res = await activeDriver({ drivers: [twins], boundTo: "iPhone 17 Pro", boundId: "SIM-2" });
    expect(res.udid).toBe("SIM-2");
  });

  it("an explicit device still wins over the bound id", async () => {
    const res = await activeDriver({ drivers: [twins], device: "SIM-1", boundTo: "iPhone 17 Pro", boundId: "SIM-2" });
    expect(res.udid).toBe("SIM-1");
  });

  it("a bound id that is no longer booted falls back to the name", async () => {
    await expect(activeDriver({ drivers: [twins], boundTo: "iPhone 17 Pro", boundId: "SIM-9" })).rejects.toThrow(/ambiguous/);
  });
});
