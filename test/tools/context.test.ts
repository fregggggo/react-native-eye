import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { getRegistry } from "../../src/core/registry.js";
import { deviceContext, runtimeContext } from "../../src/tools/context.js";
import { startFakeMetro, evalEnvelope, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().active_or_null?.close?.();
  await metro?.close();
});

function driver(platform: "ios" | "android", udid: string, name: string): DeviceDriver {
  return { platform, listDevices: async () => [{ platform, udid, name, booted: true }] } as unknown as DeviceDriver;
}
const drivers = [driver("ios", "SIM-1", "iPhone 17 Pro Max"), driver("android", "emulator-5554", "sdk_gphone64_arm64")];

async function connectTo(deviceName: string | undefined) {
  metro = await startFakeMetro({ port: 0, targets: [{ id: "t1", title: "app", ...(deviceName ? { deviceName } : {}) } as any] });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => evalEnvelope(undefined));
  await getRegistry().connect({ port: metro.port });
}

// Field test D39: with the JS connection on the iPhone, a call that named the
// Android emulator read the iPhone app's layout and reported it as Android's.
describe("an explicit device and the JS connection must be the same device", () => {
  it("deviceContext drops a connection that belongs to another device", async () => {
    await connectTo("iPhone 17 Pro Max");
    const ctx = await deviceContext({ drivers, device: "emulator-5554" });
    expect(ctx.udid).toBe("emulator-5554");
    expect(ctx.conn).toBeUndefined();
  });

  it("runtimeContext refuses, naming both devices and the connect call", async () => {
    await connectTo("iPhone 17 Pro Max");
    const err = await runtimeContext({ drivers, device: "emulator-5554" }).catch((e) => e);
    expect(err.message).toMatch(/iPhone 17 Pro Max/);
    expect(err.message).toMatch(/sdk_gphone64_arm64/);
    expect(err.message).toMatch(/connect/);
  });

  it("keeps the connection when the explicit device is the connected one (Metro decorates the name)", async () => {
    await connectTo("sdk_gphone64_arm64 - 16 - API 36");
    const ctx = await deviceContext({ drivers, device: "emulator-5554" });
    expect(ctx.conn?.meta.deviceName).toBe("sdk_gphone64_arm64 - 16 - API 36");
    expect((await runtimeContext({ drivers, device: "emulator-5554" })).conn).toBeDefined();
  });

  it("keeps the connection when Metro reports no device name (nothing to compare)", async () => {
    await connectTo(undefined);
    expect((await deviceContext({ drivers, device: "emulator-5554" })).conn).toBeDefined();
  });

  it("without an explicit device the connection's device is used, as before", async () => {
    await connectTo("iPhone 17 Pro Max");
    const ctx = await deviceContext({ drivers });
    expect(ctx.udid).toBe("SIM-1");
    expect(ctx.conn).toBeDefined();
  });
});
