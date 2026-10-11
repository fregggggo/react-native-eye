import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("privacy contract", () => {
  it("source contains no non-localhost http(s) URL", () => {
    const files = walk("src").filter((f) => f.endsWith(".ts"));
    const urlRe = /https?:\/\/([a-z0-9.-]+)/gi;
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf-8");
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(content))) {
        const host = m[1].toLowerCase();
        if (host !== "localhost" && host !== "127.0.0.1") offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("tool surface has no license/account/feedback/telemetry tools", () => {
    const server = buildServer();
    // @ts-expect-error internal registry
    const names = Object.keys(server._registeredTools);
    const forbidden = names.filter((n) => /license|account|feedback|telemetry|billing|activate/i.test(n));
    expect(forbidden).toEqual([]);
  });
});
