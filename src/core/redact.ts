import { createHash } from "node:crypto";

/**
 * Secret masking for what the debug tools pass on from the app: console logs,
 * captured errors, network URLs and bodies, store state. All of it ends up in
 * a model's context and, from there, in transcripts and logs the developer
 * does not control — an access token printed by `console.log(response)` should
 * not travel that far just because someone asked for the last 30 log lines.
 *
 * A masked value becomes `[redacted:1a2b3c]`. The id is a short hash of the
 * value, so "is the refresh call sending the token the login returned?" stays
 * answerable without ever showing the token.
 *
 * `RNE_SHOW_SECRETS=1` in the server's environment turns it off. That is the
 * developer's switch, deliberately not a tool parameter: a per-call flag is a
 * flag the model can set for itself.
 *
 * eval_js is not masked — its result is whatever the caller asked for.
 */

const ON_VALUES = new Set(["1", "true", "on", "yes"]);

export function secretsShown(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON_VALUES.has((env.RNE_SHOW_SECRETS ?? "").trim().toLowerCase());
}

const MARK = "[redacted:";

function tag(value: string): string {
  return `${MARK}${createHash("sha256").update(value).digest("hex").slice(0, 6)}]`;
}

/**
 * Key names whose value is a secret wherever they appear: accessToken,
 * refresh_token, x-api-key, client_secret, Set-Cookie, sessionId, …
 */
const KEY =
  "[A-Za-z0-9_.$-]*(?:pass(?:word|wd|code|phrase)|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|credential|private[-_]?key|signature|otp|cvv|cvc)[A-Za-z0-9_$-]*";

/** Tokens recognisable by their own shape, whatever they sit next to. */
const SHAPES: RegExp[] = [
  // PEM private key block (possibly cut short by a body cap).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // JWT: three base64url parts, the first two being JSON objects ("eyJ").
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  // Vendor prefixes: OpenAI/Anthropic-style, Stripe, GitHub, AWS, Google, Slack.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/** `Bearer abc…` / `Basic dXNlcjpwYXNz` — the scheme stays, the credential goes. */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** The password of `scheme://user:password@host`. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;

/** `Cookie: a=1; b=2` as a header line: the whole line is the secret. */
const COOKIE_LINE = /\b((?:set-)?cookie\s*:\s*)([^\n"'\\]+)/gi;

/**
 * `"access_token":"…"`, `password: '…'`, `\"token\":\"…\"` (JSON inside a
 * JSON string). A value cut by a body cap has no closing quote; it is masked
 * as far as it goes.
 */
const QUOTED_VALUE = new RegExp(`((?:\\\\?["'])?${KEY}(?:\\\\?["'])?\\s*[:=]\\s*\\\\?["'\`])([^"'\`\\\\\\n]+)`, "gi");

/**
 * `"tokens":{"access":"…","refresh":"…"}` — the object under a sensitive key.
 * One level only: its string values are masked, its keys and numbers kept.
 */
const OBJECT_VALUE = new RegExp(`((?:\\\\?["'])?${KEY}(?:\\\\?["'])?\\s*:\\s*)(\\{[^{}]*\\})`, "gi");
const STRING_FIELD = /(:\s*\\?["'`])([^"'`\\\n]+)/g;

/** `?access_token=…&`, `password=…` in a form body. */
const EQUALS_VALUE = new RegExp(`(\\b${KEY}=)([^\\s&"'\`,;<>{}\\[\\]\\\\]+)`, "gi");

/** `token: abc123…` with no quotes — a console preview or a header-like line. */
const COLON_VALUE = new RegExp(`(\\b${KEY}["']?\\s*:\\s*)([^\\s"'\`,;&<>{}\\[\\]()\\\\]{6,})`, "gi");

/** `"otp":123456`, `cvv: 123` — short numeric secrets. */
const NUMERIC_VALUE = /((?:\\?["'])?(?:otp|cvv|cvc|pin|pass(?:word|code))(?:\\?["'])?\s*[:=]\s*)(\d{3,})\b/gi;

const SCHEME_WORD = /^(?:Bearer|Basic|Digest|Token|JWT|MAC)$/i;
const LITERAL = /^(?:true|false|null|undefined|NaN|-?\d+(?:\.\d+)?)$/i;

export type Redaction = { text: string; count: number };

/** Masks secrets in `input`; `count` is how many values were masked. */
export function redact(input: string, env: NodeJS.ProcessEnv = process.env): Redaction {
  if (!input || secretsShown(env)) return { text: input, count: 0 };
  let count = 0;
  const mask = (value: string): string => {
    count++;
    return tag(value);
  };
  let out = input;
  for (const re of SHAPES) out = out.replace(re, (m) => mask(m));
  out = out.replace(AUTH_SCHEME, (m, scheme: string, gap: string, cred: string) =>
    // "Bearer token" in prose, or a credential a shape rule already masked.
    /^[a-z]+$/.test(cred) ? m : `${scheme}${gap}${mask(cred)}`,
  );
  out = out.replace(URL_USERINFO, (_m, head: string, pass: string, at: string) => `${head}${mask(pass)}${at}`);
  out = out.replace(COOKIE_LINE, (m, head: string, value: string) =>
    value.includes(MARK) || !value.includes("=") ? m : `${head}${mask(value.trimEnd())}`,
  );
  out = out.replace(QUOTED_VALUE, (m, head: string, value: string) => {
    // What is left of a value a rule above already handled ("Bearer [redacted:…]").
    if (value.includes(MARK)) return m;
    // `tokenType: "Bearer"` names a scheme, it is not a credential.
    if (SCHEME_WORD.test(value)) return m;
    return `${head}${mask(value)}`;
  });
  out = out.replace(OBJECT_VALUE, (_m, head: string, body: string) =>
    head + body.replace(STRING_FIELD, (f, h: string, value: string) => (value.includes(MARK) ? f : `${h}${mask(value)}`)),
  );
  out = out.replace(EQUALS_VALUE, (m, head: string, value: string) =>
    value.startsWith(MARK.slice(0, 1)) || LITERAL.test(value) ? m : `${head}${mask(value)}`,
  );
  out = out.replace(COLON_VALUE, (m, head: string, value: string) => {
    if (LITERAL.test(value) || value.includes(MARK)) return m;
    // A bare word after a colon is far more often prose ("token: expired",
    // "password: required") than a secret; a secret has digits or is long.
    if (!/\d/.test(value) && value.length < 20) return m;
    // The scheme of a header whose credential is already masked.
    if (SCHEME_WORD.test(value)) return m;
    return `${head}${mask(value)}`;
  });
  out = out.replace(NUMERIC_VALUE, (_m, head: string, value: string) => `${head}${mask(value)}`);
  return { text: out, count };
}

/**
 * A running total across the pieces of one tool answer, and the single note
 * that explains the masks at the end of it.
 */
export class Redactor {
  private total = 0;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  apply(input: string): string {
    const r = redact(input, this.env);
    this.total += r.count;
    return r.text;
  }

  get count(): number {
    return this.total;
  }

  note(): string {
    return redactionNote(this.total);
  }
}

/** The one line that explains the masks, for the end of a tool answer. */
export function redactionNote(count: number): string {
  return count > 0
    ? `\n(note: ${count} secret-looking value${count === 1 ? "" : "s"} masked as [redacted:<id>] — the same id means the same value. ` +
        `The developer can set RNE_SHOW_SECRETS=1 in the server's environment to see them.)`
    : "";
}
