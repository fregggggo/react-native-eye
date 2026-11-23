import { describe, it, expect } from "vitest";
import { redact, Redactor, redactionNote, secretsShown } from "../../src/core/redact.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const on = {} as NodeJS.ProcessEnv;
const r = (s: string) => redact(s, on);

describe("redact", () => {
  it("masks a JWT wherever it sits and keeps the surrounding text", () => {
    const out = r(`login ok ${JWT} for user 7`);
    expect(out.text).toMatch(/^login ok \[redacted:[0-9a-f]{6}\] for user 7$/);
    expect(out.count).toBe(1);
  });

  it("gives the same value the same id and different values different ids", () => {
    const a = r(`{"accessToken":"abc123def456"}`).text;
    const b = r(`sent accessToken=abc123def456`).text;
    const c = r(`{"accessToken":"zzz999yyy888"}`).text;
    const id = (s: string) => /\[redacted:([0-9a-f]{6})\]/.exec(s)?.[1];
    expect(id(a)).toBeDefined();
    expect(id(a)).toBe(id(b));
    expect(id(a)).not.toBe(id(c));
  });

  it("masks sensitive keys in JSON, keeping the keys and the other fields", () => {
    const out = r(`{"user":"anna","password":"hunter2","refresh_token":"r-1","client_secret":"s3","x-api-key":"k","count":3}`);
    expect(out.text).toContain(`"user":"anna"`);
    expect(out.text).toContain(`"count":3`);
    expect(out.text).not.toMatch(/hunter2|r-1|"s3"|"k"/);
    expect(out.count).toBe(4);
  });

  it("masks JSON nested inside a JSON string", () => {
    const out = r(`{"body":"{\\"token\\":\\"abcdef123456\\"}"}`);
    expect(out.text).not.toContain("abcdef123456");
    expect(out.text).toContain(`\\"token\\":\\"[redacted:`);
  });

  it("masks a value cut short by a body cap", () => {
    const out = r(`{"id":1,"access_token":"abcdef0123456789…(+900 chars)`);
    expect(out.text).not.toContain("abcdef0123456789");
  });

  it("masks query-string and form values", () => {
    const out = r("https://api.example.com/v1/me?access_token=abc.def-123&page=2&api_key=KKK");
    expect(out.text).toMatch(/access_token=\[redacted:[0-9a-f]{6}\]&page=2&api_key=\[redacted:[0-9a-f]{6}\]$/);
    expect(r("grant_type=password&username=anna&password=hunter2").text).toMatch(
      /^grant_type=password&username=anna&password=\[redacted:/,
    );
  });

  it("masks the credential of an Authorization header, quoted or not, once", () => {
    for (const s of [`Authorization: Bearer abcdef0123456789`, `{"Authorization":"Bearer abcdef0123456789"}`, `{authorization: 'Basic dXNlcjpwYXNz'}`]) {
      const out = r(s);
      expect(out.text).not.toMatch(/abcdef0123456789|dXNlcjpwYXNz/);
      expect(out.text).toMatch(/(Bearer|Basic) \[redacted:/);
      expect(out.count).toBe(1);
    }
  });

  it("masks cookies, url passwords, vendor keys and private keys", () => {
    expect(r("Cookie: sid=abc; theme=dark").text).toMatch(/^Cookie: \[redacted:[0-9a-f]{6}\]$/);
    expect(r("postgres://app:s3cr3t@db.local/x").text).toMatch(/^postgres:\/\/app:\[redacted:[0-9a-f]{6}\]@db\.local\/x$/);
    expect(r("key sk_live_abcdefghijklmnop1234 used").text).not.toContain("abcdefghijklmnop");
    expect(r("ghp_abcdefghijklmnopqrstuvwxyz0123456789").text).toMatch(/^\[redacted:/);
    expect(r("AKIAIOSFODNN7EXAMPLE").text).toMatch(/^\[redacted:/);
    expect(r("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- tail").text).toMatch(/^\[redacted:[0-9a-f]{6}\] tail$/);
  });

  it("masks an unquoted console-preview value and short numeric secrets", () => {
    expect(r("{token: a1b2c3d4e5, id: 5}").text).toMatch(/^\{token: \[redacted:[0-9a-f]{6}\], id: 5\}$/);
    expect(r(`{"otp":123456,"cvv": 123}`).count).toBe(2);
  });

  it("masks the string values of an object under a sensitive key", () => {
    const out = r(`{"data":{"tokens":{"access":"abc123","refresh":"zzz","ttl":3600}},"name":"anna"}`);
    expect(out.text).not.toMatch(/abc123|zzz/);
    expect(out.text).toContain(`"ttl":3600`);
    expect(out.text).toContain(`"name":"anna"`);
    expect(out.count).toBe(2);
    expect(r(`tokenType: "Bearer"`).count).toBe(0);
  });

  it("leaves prose, literals and counters alone", () => {
    for (const s of [
      "Invalid token: expired",
      "password: required",
      "token=null",
      "hasToken: true",
      "total_tokens: 5120",
      `{"tokenCount":12,"sessionIdPresent":false}`,
      "Bearer token missing",
      "GET /feed?page=2&limit=20 → 200",
      "the basic idea works",
    ]) {
      expect(r(s)).toEqual({ text: s, count: 0 });
    }
  });

  it("is idempotent", () => {
    const once = r(`{"Authorization":"Bearer abcdef0123456789","url":"https://x.io/?token=q1w2e3r4"} Cookie: a=b`).text;
    expect(r(once)).toEqual({ text: once, count: 0 });
  });

  it("is switched off by RNE_SHOW_SECRETS", () => {
    const env = { RNE_SHOW_SECRETS: "1" } as NodeJS.ProcessEnv;
    expect(secretsShown(env)).toBe(true);
    expect(redact(`{"password":"hunter2"}`, env)).toEqual({ text: `{"password":"hunter2"}`, count: 0 });
    expect(secretsShown({ RNE_SHOW_SECRETS: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("Redactor totals across pieces and explains itself once", () => {
    const red = new Redactor(on);
    red.apply(`{"password":"hunter2"}`);
    red.apply("nothing here");
    red.apply(`token=q1w2e3r4`);
    expect(red.count).toBe(2);
    expect(red.note()).toContain("2 secret-looking values masked");
    expect(redactionNote(0)).toBe("");
    expect(redactionNote(1)).toContain("1 secret-looking value masked");
  });
});
