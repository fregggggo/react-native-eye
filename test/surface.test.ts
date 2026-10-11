import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildServer } from "../src/server.js";

describe("tool surface", () => {
  it("registers the full v1 tool set", () => {
    const server = buildServer();
    // @ts-expect-error internal registry
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(
      [
        "check_state",
        "connect",
        "eval_js",
        "get_component_tree",
        "get_errors",
        "get_fps",
        "get_job",
        "get_layout",
        "get_logs",
        "get_network",
        "get_state",
        "install_app",
        "launch_app",
        "list_devices",
        "list_targets",
        "navigate",
        "observe",
        "open_simulator",
        "open_url",
        "ping",
        "press_key",
        "profile_js",
        "profile_renders",
        "read_screen_text",
        "record_video",
        "reload_app",
        "run_flow",
        "sample_cpu",
        "screenshot",
        "scroll_to",
        "set_permission",
        "stop_recording",
        "swipe",
        "tap",
        "type_text",
      ].sort(),
    );
  });

  it("RNE_FILTERED_TOOLS removes tools from the surface", () => {
    process.env.RNE_FILTERED_TOOLS = "record_video, stop_recording";
    try {
      const server = buildServer();
      // @ts-expect-error internal registry
      const names = Object.keys(server._registeredTools);
      expect(names).not.toContain("record_video");
      expect(names).not.toContain("stop_recording");
      expect(names).toContain("tap");
    } finally {
      delete process.env.RNE_FILTERED_TOOLS;
    }
  });

  // D10: `ping` shipped undocumented for the whole life of the project and was
  // found by a human running every tool by hand. A string search is enough to
  // stop that recurring — a tool that is not even named in the README is not
  // documented, whatever else is true.
  it("documents every registered tool in the README", () => {
    const server = buildServer();
    // @ts-expect-error internal registry
    const names = Object.keys(server._registeredTools);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const undocumented = names.filter((n) => !readme.includes(`\`${n}\``));
    expect(
      undocumented,
      `Registered but never named in README.md: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });
});
