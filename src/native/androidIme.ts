import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, TIMEOUTS } from "../core/exec.js";
import { NativeCallError } from "./httpClient.js";

/** Our IME (native/android-server app APK, process :ime). */
export const RNE_IME = "dev.rneye.server/.input.RneInputMethodService";
/**
 * The receiver is named explicitly: since API 26 a manifest receiver gets no
 * *implicit* broadcast while its uid is idle (after `am force-stop`, or while
 * only the :ime process is dead), and `adb shell am broadcast` is not exempt.
 */
const RECEIVER = "dev.rneye.server/.receivers.UnicodeInputReceiver";
const ACTION_COMMIT = "dev.rneye.server.ime.commitText";
const ACTION_STATUS = "dev.rneye.server.ime.status";
/** FLAG_INCLUDE_STOPPED_PACKAGES: after `am force-stop` our package is "stopped". */
const INCLUDE_STOPPED = "0x20";
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 300;
const SETTLE_MS = 250;
const CHUNK_UNITS = 1000;

/**
 * The keyboard to give back, kept on the host while ours is selected. It
 * outlives this process on purpose: a host that dies between `ime set RNE_IME`
 * and the restore (stdin closed mid-type, SIGKILL, a crash) leaves our
 * invisible keyboard selected, and the next session's repairIme reads this to
 * put the user's own keyboard back.
 */
export type ImeMarker = {
  read(serial: string): Promise<string | undefined>;
  write(serial: string, imeId: string): Promise<void>;
  clear(serial: string): Promise<void>;
};

export type ImeDeps = {
  /** `adb -s <serial> <args…>` → stdout; throws on failure. */
  adb: (serial: string, args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  marker: ImeMarker;
};

/** Next to the server's log (androidServer.defaultLogPath), one file per device. */
export function imeMarkerPath(serial: string): string {
  return join(tmpdir(), `rne-ime-${serial.replace(/[^\w.-]/g, "_")}`);
}

export const fileImeMarker: ImeMarker = {
  read: async (serial) => {
    try {
      return (await readFile(imeMarkerPath(serial), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  write: (serial, imeId) => writeFile(imeMarkerPath(serial), `${imeId}\n`),
  clear: (serial) => rm(imeMarkerPath(serial), { force: true }),
};

export const defaultImeDeps: ImeDeps = {
  adb: async (serial, args) => (await run("adb", ["-s", serial, ...args], { timeoutMs: TIMEOUTS.key })).stdout,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  marker: fileImeMarker,
};

/** What the server's /inputText can type with key codes (Maestro's table): printable ASCII. */
export function isKeyCodeText(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/** Chunks of at most `max` UTF-16 units; a surrogate pair is never split. */
export function chunkText(text: string, max = CHUNK_UNITS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur.length + ch.length > max) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const resultCode = (out: string) => {
  const m = /result=(-?\d+)/.exec(out);
  return m ? Number(m[1]) : undefined;
};
const resultData = (out: string) => /data="([^"]*)"/.exec(out)?.[1] ?? out.trim().slice(-200);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * IME ids come from the device (`settings get`, `ime list -s`, the marker) and
 * reach the device's sh through `adb shell`, which joins its arguments: a
 * nested-class service (`pkg/.Outer$Svc`) would be expanded by sh unquoted.
 */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The same command, for a person to paste into their own (host) shell. */
function fixCommand(serial: string, imeId: string): string {
  return /^[\w./:@%+,-]+$/.test(imeId)
    ? `adb -s ${serial} shell ime set ${imeId}`
    : `adb -s ${serial} shell ${shq(`ime set ${shq(imeId)}`)}`;
}

type Adb = (args: string[]) => Promise<string>;

function adbFor(serial: string, deps: ImeDeps): Adb {
  return async (args) => {
    try {
      return await deps.adb(serial, args);
    } catch (e) {
      if (e instanceof NativeCallError) throw e;
      throw new NativeCallError("rejected", `adb ${args.slice(0, 3).join(" ")} failed: ${messageOf(e)}`);
    }
  };
}

/**
 * One IME session per device at a time. Two concurrent non-ASCII type_text
 * calls would otherwise race: the second reads our IME as "the user's" and
 * whichever finishes last decides which keyboard the user gets back. The
 * startup repair joins the same queue so it never undoes a type in progress.
 */
const queues = new Map<string, Promise<void>>();
function exclusive<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(serial) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(serial, tail);
  void tail.then(() => {
    if (queues.get(serial) === tail) queues.delete(serial);
  });
  return run;
}

/**
 * Which keyboard to give back, given what is selected now. The selected one,
 * unless it is ours (a host died mid-type) or unset: then the one the marker
 * recorded before that host switched, if it is still enabled, else the first
 * other enabled IME. "" when there is none.
 */
async function restoreTarget(adb: Adb, current: string, recorded: string | undefined): Promise<string> {
  if (current && current !== "null" && current !== RNE_IME) return current;
  const enabled = (await adb(["shell", "ime", "list", "-s"])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (recorded && recorded !== RNE_IME && enabled.includes(recorded)) return recorded;
  return enabled.find((id) => id !== RNE_IME) ?? "";
}

const currentIme = async (adb: Adb) => (await adb(["shell", "settings", "get", "secure", "default_input_method"])).trim();

/**
 * Switch to `restoreTo`, forget the marker, and take our IME out of the
 * user's keyboard picker. Only the switch can fail the call: the marker and
 * `ime disable` are best effort.
 */
async function giveBack(serial: string, adb: Adb, deps: ImeDeps, restoreTo: string): Promise<void> {
  await adb(["shell", "ime", "set", shq(restoreTo)]);
  await deps.marker.clear(serial).catch(() => {});
  await adb(["shell", "ime", "disable", RNE_IME]).catch(() => {});
}

/**
 * Types any Unicode text into the focused field through our IME, then gives
 * the user their keyboard back. Throws NativeCallError("rejected"). Nothing
 * here can fall back: `adb shell input text` cannot type non-ASCII.
 *
 * The keyboard to restore is the one selected before (see restoreTarget). It
 * is recorded in the host-side marker before our IME is selected, so a host
 * that dies before the restore is repaired by the next repairIme or
 * typeWithIme. With no other IME enabled, the text is typed and the call then
 * fails, so the caller learns that our invisible keyboard is still selected.
 */
export function typeWithIme(serial: string, text: string, deps: ImeDeps = defaultImeDeps): Promise<void> {
  return exclusive(serial, () => typeExclusive(serial, text, deps));
}

async function typeExclusive(serial: string, text: string, deps: ImeDeps): Promise<void> {
  const adb = adbFor(serial, deps);
  const original = await currentIme(adb);
  const recorded = await deps.marker.read(serial).catch(() => undefined);
  const restoreTo = await restoreTarget(adb, original, recorded);
  // Before our IME is selected, so a host that dies from here on leaves a record.
  if (restoreTo) await deps.marker.write(serial, restoreTo).catch(() => {});
  else if (recorded) await deps.marker.clear(serial).catch(() => {}); // names a keyboard no longer enabled

  let failure: unknown;
  try {
    await adb(["shell", "ime", "enable", RNE_IME]);
    await adb(["shell", "ime", "set", RNE_IME]);
    await waitReady(adb, deps);
    for (const chunk of chunkText(text)) {
      const out = await adb([
        "shell", "am", "broadcast", "-f", INCLUDE_STOPPED, "-n", RECEIVER, "-a", ACTION_COMMIT,
        "--es", "textBase64", Buffer.from(chunk, "utf8").toString("base64url"),
      ]);
      if (resultCode(out) !== -1) {
        throw new NativeCallError("rejected", `the RNEye keyboard did not commit the text (${resultData(out)})`);
      }
    }
    await deps.sleep(SETTLE_MS);
  } catch (e) {
    failure = e;
  }
  let restoreFailure: unknown;
  if (restoreTo) {
    try {
      await giveBack(serial, adb, deps, restoreTo);
    } catch (e) {
      restoreFailure = e;
    }
  }
  if (failure && restoreFailure) {
    const f = failure instanceof NativeCallError ? failure : new NativeCallError("rejected", messageOf(failure));
    throw new NativeCallError(
      f.kind,
      `${f.message}; the RNEye keyboard is also still selected — restoring the previous one failed ` +
        `(${messageOf(restoreFailure)}). Run \`${fixCommand(serial, restoreTo)}\` (the next session also retries it)`,
      f.status,
      f.code,
    );
  }
  if (failure) throw failure;
  if (restoreFailure) {
    throw new NativeCallError(
      "rejected",
      `typed, but could not restore the keyboard (${messageOf(restoreFailure)}) — run \`${fixCommand(serial, restoreTo)}\``,
    );
  }
  if (!restoreTo) {
    throw new NativeCallError(
      "rejected",
      `typed, but no other keyboard is enabled to switch back to — pick one in Settings → System → Keyboard (adb -s ${serial} shell ime list -a)`,
    );
  }
}

/**
 * What repairIme found: our IME was not selected (nothing to do), it was and
 * the given keyboard is selected again, or it was and no other one is enabled.
 */
export type ImeRepair = { kind: "clean" } | { kind: "restored"; to: string } | { kind: "stuck" };

/**
 * Gives the user their keyboard back if our IME is still selected — a host
 * that died mid-type (stdin closed, SIGKILL, crash) or whose own restore
 * failed. Run in the background when a session first uses a device's server;
 * costs one `settings get` when there is nothing to repair. Throws
 * NativeCallError("rejected") only when the adb calls themselves fail.
 */
export function repairIme(serial: string, deps: ImeDeps = defaultImeDeps): Promise<ImeRepair> {
  return exclusive(serial, async () => {
    const adb = adbFor(serial, deps);
    const current = await currentIme(adb);
    if (current !== RNE_IME) {
      await deps.marker.clear(serial).catch(() => {});
      return { kind: "clean" };
    }
    const recorded = await deps.marker.read(serial).catch(() => undefined);
    const to = await restoreTarget(adb, current, recorded);
    if (!to) return { kind: "stuck" };
    await giveBack(serial, adb, deps, to);
    return { kind: "restored", to };
  });
}

async function waitReady(adb: (args: string[]) => Promise<string>, deps: ImeDeps): Promise<void> {
  const deadline = deps.now() + READY_TIMEOUT_MS;
  for (;;) {
    const out = await adb(["shell", "am", "broadcast", "-f", INCLUDE_STOPPED, "-n", RECEIVER, "-a", ACTION_STATUS]);
    if (resultCode(out) === -1) return;
    if (deps.now() >= deadline) {
      throw new NativeCallError(
        "rejected",
        `the RNEye keyboard did not become active within 5s (${resultData(out)}) — is a text field focused? ` +
          "Some OEM or managed devices block third-party keyboards.",
      );
    }
    await deps.sleep(READY_POLL_MS);
  }
}
