export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export class DriverError extends Error {
  /**
   * `message` is always the full text — every existing caller and every
   * existing test that reads `.message` keeps seeing exactly what it sees
   * today, whether or not a recommendation is passed. `recommendation`, when
   * given, is the trailing next-step clause already folded into `message`;
   * `diagnosis` is `message` with that clause never appended, so a caller
   * that needs to fold this error into a larger one describing a second,
   * unrelated failure can take the diagnosis on its own — no regexing a
   * trailing sentence back out of `message` (a recommendation that is correct
   * in isolation, e.g. "retry over the JS path", can be actively wrong once
   * folded into a message that already reports the JS path failed too; see
   * captureLayoutWithSource in layout.ts).
   */
  readonly diagnosis: string;
  readonly recommendation?: string;

  constructor(diagnosis: string, recommendation?: string) {
    super(recommendation ? `${diagnosis} ${recommendation}` : diagnosis);
    this.name = "DriverError";
    this.diagnosis = diagnosis;
    this.recommendation = recommendation;
  }
}

/**
 * The app's own code failed — it threw, rejected, or never settled. Distinct from
 * ConnectionError on purpose: the connection is fine, and telling the user to
 * restart Metro because their `JSON.parse` threw sends them the wrong way.
 */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

type ToolError = {
  content: { type: "text"; text: string }[];
  isError: true;
};

/**
 * Binaries our drivers shell out to, keyed by the program name exec.ts
 * reports as missing (`${cmd} not found — is it installed and on PATH?`),
 * mapped to a one-line install/expose instruction. Only binaries we actually
 * depend on are listed — a made-up install line for an unrecognised binary
 * would be a guess, and a wrong next step is worse than none.
 */
const BINARY_INSTALL: Record<string, string> = {
  axe: "brew install cameroncooke/axe/axe",
  adb: "install Android platform-tools and put it on PATH (Android Studio's SDK Manager, or `brew install android-platform-tools`)",
  xcrun: "install the Xcode Command Line Tools: `xcode-select --install`",
  idb: "brew tap facebook/fb && brew install idb-companion, then pip3 install fb-idb",
};

// Matches the input commands that actually deliver a touch to the device:
// axe tap/touch/swipe on iOS, `input tap`/`input swipe` on Android (the
// latter quoted by shellQuote, hence the optional quote character).
const TOUCH_COMMAND_RE = /\b(?:axe\s+(?:tap|touch|swipe)|input\s+['"]?(?:tap|swipe))\b/i;

export type DriverErrorHint = { hint: string; replace?: boolean };

/**
 * Maps a DriverError's message to a next step for the calling agent, for the
 * failure modes field testing actually hit. Pure and process-free so it is
 * unit-testable without spawning anything.
 *
 * toToolError decides how to apply the result: normally the hint is
 * appended after the original message, but a CLI usage dump (`replace:
 * true`) is swapped in instead of the raw multi-line dump, since forwarding
 * that dump would make our own bad argument look like the caller's mistake.
 *
 * Returns undefined for anything not recognised — never guesses a next step.
 */
export function driverErrorHint(message: string): DriverErrorHint | undefined {
  // CLI usage dump: the tool printed its own `Usage:` text because *we*
  // passed a bad argument. Forwarding the raw dump reads like the caller's
  // input was wrong, so collapse it to which argument broke instead.
  if (/\bUsage:/.test(message)) {
    const arg =
      /invalid for '(-{1,2}[\w-]+)/i.exec(message)?.[1] ??
      /[Mm]issing expected argument '(-{1,2}[\w-]+)/.exec(message)?.[1];
    const argPart = arg ? ` a bad "${arg}" argument` : " a bad argument";
    return {
      replace: true,
      hint: `react-native-eye passed the device tooling${argPart} — that's a bug in this tool, not your input. Retrying the same call will not help; please report it.`,
    };
  }

  // Touch delivery timed out. Measured 14-24s against a hot RN app (see D1)
  // — the touch may have landed anyway, so a blind retry risks a double tap.
  if (/timed out/i.test(message) && TOUCH_COMMAND_RE.test(message)) {
    return {
      hint:
        'The touch may or may not have reached the device before the timeout — retrying risks a double tap. ' +
        'Check the screen (screenshot or get_layout) before trying again. Where possible, skip the OS touch ' +
        'path entirely: via: "js", scroll_to, and open_url deliver no touch event and cost about 1ms instead ' +
        "of the 14-24s a touch takes here.",
    };
  }

  // Missing binary — exec.ts reports ENOENT as "<cmd> not found — is it
  // installed and on PATH?"; only hint for the binaries we know.
  const missing = /^(\S+) not found — is it installed and on PATH\?/.exec(message);
  if (missing) {
    const install = BINARY_INSTALL[missing[1]];
    return install ? { hint: `Install it: ${install}.` } : undefined;
  }

  // No device booted at all.
  if (/No booted device found/i.test(message)) {
    return {
      hint:
        "Boot a device first — open_simulator (iOS) or start an Android emulator — then confirm with " +
        "list_devices before retrying.",
    };
  }

  // A specific device the caller named exists but isn't booted.
  if (/ is not booted\.?$/i.test(message)) {
    return { hint: "Boot it first — open_simulator (iOS) or start the emulator (Android) — then retry." };
  }

  // The device name/udid the caller passed matched nothing.
  if (/^No device matching/i.test(message)) {
    return { hint: "Run list_devices to see the exact name or udid to pass." };
  }

  // App not installed.
  if (/not installed/i.test(message)) {
    return { hint: "Install the app first with install_app, then retry." };
  }
  if (/No activities found to run, monkey aborted|Activity class .*does not exist/i.test(message)) {
    return {
      hint:
        "Android found no launchable activity for that package — install it with install_app first, or " +
        "check the app id.",
    };
  }

  return undefined;
}

export function toToolError(err: unknown): ToolError {
  const e = err instanceof Error ? err : new Error(String(err));
  // Full detail (including stack) goes to stderr, never to the agent.
  console.error(`[react-native-eye] ${e.name}: ${e.message}\n${e.stack ?? ""}`);

  let text: string;
  switch (e.name) {
    case "ConnectionError":
      text = `Not connected: ${e.message}\nRun 'connect' (optionally with a port) after starting Metro.`;
      break;
    case "DriverError": {
      const h = driverErrorHint(e.message);
      if (!h) {
        text = `Driver error: ${e.message}`;
      } else if (h.replace) {
        text = `Driver error: ${h.hint}`;
      } else {
        text = `Driver error: ${e.message} ${h.hint}`;
      }
      break;
    }
    case "RuntimeError":
      text = `App error: ${e.message}`;
      break;
    case "UserInputError":
      text = e.message;
      break;
    default:
      text = `Unexpected error: ${e.message}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}
