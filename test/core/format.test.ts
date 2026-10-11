import { describe, it, expect } from "vitest";
import { text, truncate } from "../../src/core/format.js";

describe("format helpers", () => {
  it("text wraps a string as MCP content", () => {
    expect(text("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });
  it("truncate marks the cut", () => {
    expect(truncate("abcdef", 3)).toBe("abc…(+3 chars)");
    expect(truncate("ab", 3)).toBe("ab");
  });
});
