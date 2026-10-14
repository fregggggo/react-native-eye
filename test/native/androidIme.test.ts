import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  chunkText,
  imeMarkerPath,
  isKeyCodeText,
  repairIme,
  typeWithIme,
  RNE_IME,
  type ImeDeps,
} from "../../src/native/androidIme.js";
import { NativeCallError } from "../../src/native/httpClient.js";

const GBOARD = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME";
const SWIFTKEY = "com.touchtype.swiftkey/com.touchtype.KeyboardService";
/** A nested-class service: the `$` is expanded by an unquoting shell. */
const NESTED = "com.oem.kbd/.Outer$Svc";
const OK = 'Broadcast completed: result=-1, data="ready"';
const NOT_READY = 'Broadcast completed: result=1, data="no input connection"';
const NOBODY = "Broadcast completed: result=0";
/** How an IME id reaches the device's sh. */
const q = (id: string) => `'${id}'`;

type Script = {
  current?: string;
  list?: string;
  status?: string[];
  commit?: string;
  failOn?: string;
  /** What the host-side marker holds before the call. */
  marker?: string;
  /** The adb call whose line includes `on` waits for `wait` first. */
  gate?: { on: string; wait: Promise<void> };
};

function fakeDeps(script: Script) {
  const calls: string[][] = [];
  /** adb calls and marker operations, in order. */
  const log: string[] = [];
  const status = [...(script.status ?? [OK])];
  let current = script.current ?? GBOARD;
  let marker = script.marker;
  let clock = 0;
  const deps: ImeDeps = {
    adb: async (serial, args) => {
      const line = args.join(" ");
      if (script.gate && line.includes(script.gate.on)) await script.gate.wait;
      calls.push([serial, ...args]);
      log.push(line);
      if (script.failOn && line.includes(script.failOn)) throw new Error(`adb failed: ${script.failOn}`);
      if (line.includes("settings get secure default_input_method")) return `${current}\n`;
      if (line.startsWith("shell ime set ")) current = line.slice("shell ime set ".length).replace(/^'|'$/g, "");
      if (line.includes("ime list -s")) return script.list ?? `${GBOARD}\n${RNE_IME}\n`;
      if (line.includes("dev.rneye.server.ime.status")) return status.length > 1 ? status.shift()! : status[0];
      if (line.includes("dev.rneye.server.ime.commitText")) return script.commit ?? 'Broadcast completed: result=-1, data="committed"';
      return "";
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    marker: {
      read: async () => marker,
      write: async (_serial, id) => {
        log.push(`marker write ${id}`);
        marker = id;
      },
      clear: async () => {
        log.push("marker clear");
        marker = undefined;
      },
    },
  };
  const shell = () => calls.map((c) => c.slice(1).join(" "));
  return { deps, calls, shell, log, marker: () => marker, current: () => current };
}

describe("isKeyCodeText", () => {
  it("is true for printable ASCII only", () => {
    expect(isKeyCodeText("Hello, world! ~_{}")).toBe(true);
    expect(isKeyCodeText("")).toBe(true);
    expect(isKeyCodeText("こんにちは")).toBe(false);
    expect(isKeyCodeText("café")).toBe(false);
    expect(isKeyCodeText("line\nbreak")).toBe(false);
    expect(isKeyCodeText("👋")).toBe(false);
  });
});

describe("chunkText", () => {
  it("keeps short text whole", () => {
    expect(chunkText("こんにちは")).toEqual(["こんにちは"]);
  });
  it("splits at the UTF-16 limit without cutting a surrogate pair", () => {
    const text = "a".repeat(999) + "👋" + "b";
    const chunks = chunkText(text, 1000);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("a".repeat(999));
    expect(chunks[1]).toBe("👋b");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
});

describe("typeWithIme", () => {
  it("selects our IME, waits for it, commits base64url text, then restores the user's IME and disables ours", async () => {
    const f = fakeDeps({ status: [NOT_READY, NOBODY, OK] });
    await typeWithIme("emulator-5554", "こんにちは 👋", f.deps);
    const s = f.shell();
    expect(f.calls.every((c) => c[0] === "emulator-5554")).toBe(true);
    expect(s[0]).toBe("shell settings get secure default_input_method");
    expect(s).toContain(`shell ime enable ${RNE_IME}`);
    expect(s).toContain(`shell ime set ${RNE_IME}`);
    expect(s.filter((l) => l.includes("ime.status"))).toHaveLength(3);
    const commit = s.find((l) => l.includes("commitText"))!;
    expect(commit).toContain("-f 0x20");
    expect(commit).toContain("-n dev.rneye.server/.receivers.UnicodeInputReceiver");
    expect(s.filter((l) => l.includes("ime.status")).every((l) => l.includes("-f 0x20 -n dev.rneye.server/.receivers.UnicodeInputReceiver"))).toBe(true);
    const b64 = commit.split(" ").at(-1)!;
    expect(Buffer.from(b64, "base64url").toString("utf8")).toBe("こんにちは 👋");
    expect(b64).not.toMatch(/[+/=]/);
    expect(s.slice(-2)).toEqual([`shell ime set ${q(GBOARD)}`, `shell ime disable ${RNE_IME}`]);
    expect(f.current()).toBe(GBOARD);
  });

  it("records the keyboard to restore on the host before selecting ours, and forgets it once restored", async () => {
    const f = fakeDeps({});
    await typeWithIme("S", "é", f.deps);
    const write = f.log.indexOf(`marker write ${GBOARD}`);
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(f.log.indexOf(`shell ime set ${RNE_IME}`));
    expect(f.log.indexOf("marker clear")).toBeGreaterThan(f.log.indexOf(`shell ime set ${q(GBOARD)}`));
    expect(f.marker()).toBeUndefined();
  });

  it("quotes the restore target for the device shell", async () => {
    const f = fakeDeps({ current: NESTED });
    await typeWithIme("S", "é", f.deps);
    expect(f.shell()).toContain(`shell ime set '${NESTED}'`);
  });

  it("treats result=0 as not ready (an ordered broadcast nobody receives also ends with 0)", async () => {
    const f = fakeDeps({ status: [NOBODY] });
    const e = await typeWithIme("S", "こんにちは", f.deps).catch((x) => x);
    expect(e).toBeInstanceOf(NativeCallError);
    expect((e as NativeCallError).kind).toBe("rejected");
    expect((e as NativeCallError).message).toMatch(/did not become active within 5s/);
    expect(f.current()).toBe(GBOARD);
  });

  it("restores the IME when the commit fails and reports the receiver's reason", async () => {
    const f = fakeDeps({ commit: 'Broadcast completed: result=1, data="commitText returned false"' });
    const e = (await typeWithIme("S", "こんにちは", f.deps).catch((x) => x)) as NativeCallError;
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/commitText returned false/);
    expect(f.current()).toBe(GBOARD);
    expect(f.marker()).toBeUndefined();
  });

  it("restores the first other enabled IME when ours is selected and nothing was recorded", async () => {
    const f = fakeDeps({ current: RNE_IME, list: `${RNE_IME}\n${GBOARD}\n` });
    await typeWithIme("S", "é", f.deps);
    expect(f.current()).toBe(GBOARD);
  });

  it("restores the keyboard a dead host recorded, not merely the first enabled one", async () => {
    const f = fakeDeps({ current: RNE_IME, marker: SWIFTKEY, list: `${GBOARD}\n${RNE_IME}\n${SWIFTKEY}\n` });
    await typeWithIme("S", "é", f.deps);
    expect(f.current()).toBe(SWIFTKEY);
    expect(f.marker()).toBeUndefined();
  });

  it("ignores a recorded keyboard that is no longer enabled", async () => {
    const f = fakeDeps({ current: RNE_IME, marker: SWIFTKEY, list: `${GBOARD}\n${RNE_IME}\n` });
    await typeWithIme("S", "é", f.deps);
    expect(f.current()).toBe(GBOARD);
  });

  it("sends one commit per chunk", async () => {
    const f = fakeDeps({});
    await typeWithIme("S", "é".repeat(2500), f.deps);
    expect(f.shell().filter((l) => l.includes("commitText"))).toHaveLength(3);
  });

  it("turns an adb failure into rejected and still restores", async () => {
    const f = fakeDeps({ failOn: "ime enable" });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e).toBeInstanceOf(NativeCallError);
    expect(e.kind).toBe("rejected");
    expect(f.shell()).toContain(`shell ime set ${q(GBOARD)}`);
  });

  it("reports a failed restore after a successful commit, naming the command to fix it, and keeps the record", async () => {
    const f = fakeDeps({ failOn: `ime set ${q(GBOARD)}` });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/typed, but could not restore the keyboard/);
    expect(e.message).toContain(`adb -s S shell ime set ${GBOARD}`);
    expect(f.marker()).toBe(GBOARD);
    expect(f.shell()).not.toContain(`shell ime disable ${RNE_IME}`);
  });

  it("the paste-able fix command survives both the host shell and the device shell", async () => {
    const f = fakeDeps({ current: NESTED, failOn: "ime set 'com.oem" });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e.message).toContain(`adb -s S shell 'ime set '\\''${NESTED}'\\'''`);
  });

  it("says our keyboard is still selected when both the typing and the restore failed", async () => {
    const f = fakeDeps({ status: [NOBODY], failOn: `ime set ${q(GBOARD)}` });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/did not become active within 5s/);
    expect(e.message).toMatch(/RNEye keyboard is also still selected/);
    expect(e.message).toContain(`adb -s S shell ime set ${GBOARD}`);
  });

  it("types, then says so when no other keyboard is enabled to switch back to", async () => {
    const f = fakeDeps({ current: RNE_IME, list: `${RNE_IME}\n` });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e).toBeInstanceOf(NativeCallError);
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/typed, but no other keyboard is enabled to switch back to/);
    expect(e.message).toContain("adb -s S shell ime list -a");
    expect(f.shell().filter((l) => l.includes("commitText"))).toHaveLength(1);
    expect(f.shell().filter((l) => l.startsWith("shell ime set"))).toEqual([`shell ime set ${RNE_IME}`]);
  });

  it("keeps the original failure when there is also nothing to restore", async () => {
    const f = fakeDeps({ current: "null", list: "", status: [NOBODY] });
    const e = (await typeWithIme("S", "é", f.deps).catch((x) => x)) as NativeCallError;
    expect(e.message).toMatch(/did not become active within 5s/);
  });

  it("runs one call at a time per device: the second reads the user's keyboard, not ours", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeDeps({ gate: { on: "commitText", wait: gate } });
    const first = typeWithIme("serial-queue", "一", f.deps);
    const second = typeWithIme("serial-queue", "二", f.deps);
    await new Promise((r) => setTimeout(r, 5));
    // The first is parked on its commit; the second has not started.
    expect(f.log.filter((l) => l.includes("default_input_method"))).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    const reads = f.log.flatMap((l, i) => (l.includes("default_input_method") ? [i] : []));
    expect(reads).toHaveLength(2);
    expect(reads[1]).toBeGreaterThan(f.log.indexOf(`shell ime set ${q(GBOARD)}`));
    expect(f.log.filter((l) => l.startsWith("marker write"))).toEqual([`marker write ${GBOARD}`, `marker write ${GBOARD}`]);
    expect(f.current()).toBe(GBOARD);
  });

  it("a failed call does not block the next one on the same device", async () => {
    const bad = fakeDeps({ failOn: "ime enable" });
    await typeWithIme("serial-fail", "é", bad.deps).catch(() => {});
    const ok = fakeDeps({});
    await expect(typeWithIme("serial-fail", "é", ok.deps)).resolves.toBeUndefined();
  });
});

describe("repairIme", () => {
  it("only reads the setting when ours is not selected, and drops a stale record", async () => {
    const f = fakeDeps({ marker: SWIFTKEY });
    expect(await repairIme("S", f.deps)).toEqual({ kind: "clean" });
    expect(f.shell()).toEqual(["shell settings get secure default_input_method"]);
    expect(f.marker()).toBeUndefined();
  });

  it("gives back the keyboard a dead host recorded, then disables ours", async () => {
    const f = fakeDeps({ current: RNE_IME, marker: SWIFTKEY, list: `${GBOARD}\n${RNE_IME}\n${SWIFTKEY}\n` });
    expect(await repairIme("S", f.deps)).toEqual({ kind: "restored", to: SWIFTKEY });
    expect(f.current()).toBe(SWIFTKEY);
    expect(f.shell().at(-1)).toBe(`shell ime disable ${RNE_IME}`);
    expect(f.marker()).toBeUndefined();
  });

  it("without a record, gives back the first other enabled keyboard", async () => {
    const f = fakeDeps({ current: RNE_IME, list: `${RNE_IME}\n${GBOARD}\n` });
    expect(await repairIme("S", f.deps)).toEqual({ kind: "restored", to: GBOARD });
    expect(f.current()).toBe(GBOARD);
  });

  it("reports stuck when no other keyboard is enabled", async () => {
    const f = fakeDeps({ current: RNE_IME, list: `${RNE_IME}\n` });
    expect(await repairIme("S", f.deps)).toEqual({ kind: "stuck" });
    expect(f.shell().some((l) => l.startsWith("shell ime set"))).toBe(false);
  });

  it("waits for a type in progress on the same device instead of undoing it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeDeps({ gate: { on: "commitText", wait: gate } });
    const typing = typeWithIme("serial-repair", "é", f.deps);
    const repair = repairIme("serial-repair", f.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(f.log.filter((l) => l.includes("default_input_method"))).toHaveLength(1);
    release();
    await typing;
    expect(await repair).toEqual({ kind: "clean" });
  });
});

describe("imeMarkerPath", () => {
  it("lives in the temp dir, one file per device, with a file-safe name", () => {
    expect(imeMarkerPath("192.168.1.5:5555")).toBe(join(tmpdir(), "rne-ime-192.168.1.5_5555"));
  });
});
