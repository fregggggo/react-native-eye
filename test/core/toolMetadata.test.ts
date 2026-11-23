import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";

// The tools of the core/debugger slice. Each parameter carries a description
// and each tool says whether it only reads, so a client can explain a call and
// auto-approve the reads.
const TOOLS: Record<string, boolean> = {
  ping: true,
  connect: false,
  list_targets: true,
  get_logs: true,
  get_errors: true,
  get_network: true,
  eval_js: false,
  get_job: true,
  get_state: true,
  get_component_tree: true,
  navigate: false,
  profile_renders: false,
  profile_js: false,
};

describe("tool metadata", () => {
  it("describes every parameter and annotates read-only-ness", () => {
    const server = buildServer();
    // @ts-expect-error _registeredTools is internal but stable in SDK 1.x
    const tools: Record<string, any> = server._registeredTools;
    const missing: string[] = [];
    for (const [name, readOnly] of Object.entries(TOOLS)) {
      const tool = tools[name];
      expect(tool, name).toBeDefined();
      expect(tool.annotations?.readOnlyHint, name).toBe(readOnly);
      if (readOnly) expect(tool.annotations?.destructiveHint, name).toBe(false);
      const shape = tool.inputSchema?.shape ?? {};
      for (const [param, schema] of Object.entries<any>(shape)) {
        if (!schema.description) missing.push(`${name}.${param}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
