import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

describe("buildServer", () => {
  it("creates a server with a registered ping tool", () => {
    const server = buildServer();
    expect(server).toBeDefined();
    // @ts-expect-error _registeredTools is internal but stable in SDK 1.x
    expect(Object.keys(server._registeredTools)).toContain("ping");
  });
});
