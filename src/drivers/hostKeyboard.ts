import { run as defaultRun, TIMEOUTS } from "../core/exec.js";

type Runner = typeof defaultRun;

/**
 * The macOS active keyboard layout id, e.g. "com.apple.keylayout.RussianWin".
 * undefined when it cannot be read.
 *
 * `axe type` sends key POSITIONS over HID and the simulator resolves them
 * through the host Mac's layout, so the layout has to be known before the
 * keyboard is used. Verified on the field-test machine:
 *
 *   $ defaults read com.apple.HIToolbox AppleCurrentKeyboardLayoutInputSourceID
 *   com.apple.keylayout.RussianWin
 *
 * The key is absent on a fresh account and while a non-keyboard input method is
 * selected; `defaults` then exits non-zero. An unreadable layout is NOT evidence
 * of a bad one, so it reads as undefined and the caller proceeds.
 *
 * Measured at 0.01s wall clock over three consecutive runs — a local plist read,
 * well under 100ms. The result is deliberately NOT cached: the user can switch
 * layout mid-session, and a cached "safe" verdict would silently corrupt every
 * string typed for the rest of the run. One cheap read per typed string is what
 * keeps the answer current.
 */
export async function activeKeyboardLayout(run: Runner = defaultRun): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "defaults",
      ["read", "com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"],
      { timeoutMs: TIMEOUTS.key },
    );
    return stdout.trim() || undefined;
  } catch {
    // Absent key, missing binary (non-macOS host), wedged cfprefsd: all of these
    // are "unknown", none of them is "unsafe".
    return undefined;
  }
}

// Deny by default. An unlisted layout is treated as unsafe, and the asymmetry is
// the point: a false refusal costs seconds and says how to recover (switch the
// host layout, or pass via: "js"), while a false accept writes corrupted text
// into the app and reports success — the exact defect this guards. Adding a
// layout here is a one-line change; being wrong the other way is data corruption
// that reads as a green run.
const ASCII_SAFE = new Set([
  "com.apple.keylayout.US",
  "com.apple.keylayout.USExtended",
  "com.apple.keylayout.ABC",
  "com.apple.keylayout.ABC-QWERTZ",
  "com.apple.keylayout.ABC-AZERTY",
  "com.apple.keylayout.British",
  "com.apple.keylayout.Australian",
  "com.apple.keylayout.Canadian",
  "com.apple.keylayout.Irish",
]);

/** True for layouts whose key positions produce the ASCII characters printed on them. */
export function isAsciiSafeLayout(id: string | undefined): boolean {
  if (id === undefined) return true; // Unknown is not a refusal.
  if (ASCII_SAFE.has(id)) return true;
  // The two Latin families ship regional variants (US-International, ABC-India)
  // that keep the letter positions printed on the keys.
  return /^com\.apple\.keylayout\.(US|ABC)/.test(id);
}
