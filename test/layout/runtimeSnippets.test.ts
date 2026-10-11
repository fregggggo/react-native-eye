import { describe, it, expect } from "vitest";
import { SAFE } from "../../src/layout/runtimeSnippets.js";
import { makeRuntime } from "../helpers/rnRuntime.js";

describe("SAFE", () => {
  it("turns a throwing property read into undefined instead of aborting the expression", () => {
    const runtime = makeRuntime();
    const out = JSON.parse(
      runtime.evaluate(`(function () {
        ${SAFE}
        // The shape behind field-test defect D4: a Reanimated style whose getter
        // throws. An unguarded read here would take down the whole capture.
        var props = { get style() { throw new Error("boom"); } };
        return JSON.stringify({
          threw: safe(function () { return props.style; }) === undefined,
          bare: safe(function () { throw new Error("boom"); }) === undefined,
          passesValuesThrough: safe(function () { return 42; })
        });
      })()`) as string,
    );
    expect(out).toEqual({ threw: true, bare: true, passesValuesThrough: 42 });
  });
});
