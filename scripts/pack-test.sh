#!/usr/bin/env bash
# npm pack install test: proves the published tarball carries working native drivers.
#
#   scripts/pack-test.sh
#
# 1. npm run build, then the prepublish gate (scripts/check-drivers.mjs).
# 2. npm pack into a temp dir; install the tarball into a fresh temp project.
# 3. Asserts on the installed copy:
#    - build/drivers is byte-identical to the local one (same file list, same content),
#      exec bits identical, and no symlinks on either side;
#    - NOTICE and the license/third-party files are in the package;
#    - build/native/artifacts.js, imported from the installed path, resolves the iOS and
#      Android artifacts with no root override;
#    - the installed bin answers MCP initialize + tools/list over stdio.
# 4. Prints tarball size, unpacked size, file count. Temp dirs are removed on exit.
#
# Host-only: touches no simulator, emulator or device (the server runs with
# RNE_NATIVE_DRIVER=off and only answers initialize/tools/list). Needs network access
# (or a warm npm cache) for the package's dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log() { printf '[pack-test] %s\n' "$*" >&2; }
die() { printf '[pack-test] FAIL: %s\n' "$*" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rne-pack-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
log "npm run build"
npm run build --silent >&2
log "check-drivers"
node scripts/check-drivers.mjs >&2

log "npm pack → $WORK/pack"
mkdir -p "$WORK/pack"
npm pack --pack-destination "$WORK/pack" --json --loglevel=error >"$WORK/pack.json"
TGZ="$(ls "$WORK"/pack/*.tgz)"
[[ -f "$TGZ" ]] || die "npm pack produced no tarball"

log "install into a fresh project → $WORK/app"
mkdir -p "$WORK/app"
(
  cd "$WORK/app"
  npm init -y >/dev/null
  npm i "$TGZ" --no-audit --no-fund --loglevel=error >&2
)
PKG="$WORK/app/node_modules/react-native-eye"
[[ -d "$PKG" ]] || die "package not installed at $PKG"

log "compare build/drivers (content, exec bits, symlinks)"
node - "$ROOT/build/drivers" "$PKG/build/drivers" <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [local, installed] = process.argv.slice(2);
function scan(root) {
  const files = new Map(), links = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name), rel = path.relative(root, p);
      if (d.isSymbolicLink()) links.push(rel);
      else if (d.isDirectory()) walk(p);
      else if (d.isFile() && !d.name.endsWith(".map")) { // source maps are left out of the package on purpose
        const st = fs.statSync(p);
        files.set(rel, { mode: st.mode & 0o777, hash: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
      }
    }
  })(root);
  return { files, links };
}
const a = scan(local), b = scan(installed);
const errs = [];
if (a.links.length) errs.push(`local build/drivers has symlinks (npm pack drops them): ${a.links.join(", ")}`);
if (b.links.length) errs.push(`installed build/drivers has symlinks: ${b.links.join(", ")}`);
for (const [rel, fa] of a.files) {
  const fb = b.files.get(rel);
  if (!fb) { errs.push(`missing after install: ${rel}`); continue; }
  if (fa.hash !== fb.hash) errs.push(`content differs: ${rel}`);
  if ((fa.mode & 0o111) !== (fb.mode & 0o111)) errs.push(`exec bits differ: ${rel} local ${fa.mode.toString(8)} installed ${fb.mode.toString(8)}`);
}
for (const rel of b.files.keys()) if (!a.files.has(rel)) errs.push(`extra after install: ${rel}`);
const modeDiffs = [...a.files].filter(([rel, f]) => b.files.get(rel) && b.files.get(rel).mode !== f.mode).length;
const execs = [...b.files.values()].filter((f) => f.mode & 0o111).length;
if (errs.length) { console.error(errs.map((e) => "  " + e).join("\n")); process.exit(1); }
console.error(`[pack-test] build/drivers identical: ${a.files.size} files, ${execs} executable, no symlinks` +
  (modeDiffs ? ` (${modeDiffs} files differ only in non-exec mode bits, umask)` : ", modes identical"));
NODE

if [[ "$(uname -s)" == Darwin ]]; then
  log "codesign --verify the installed iOS apps"
  for app in RNERunnerUITests-Runner.app RNERunner.app; do
    codesign --verify --deep --strict "$PKG/build/drivers/ios/$app" || die "installed $app fails codesign --verify"
  done
fi

log "license files in the package"
for f in NOTICE LICENSE native/LICENSE-APACHE native/ios-runner/THIRD_PARTY.md native/android-server/THIRD_PARTY.md native/android-server/licenses/junit-4.13.2-EPL-1.0.txt native/android-server/licenses/hamcrest-core-1.3-BSD-3-Clause.txt; do
  [[ -f "$PKG/$f" ]] || die "$f is not in the installed package"
  cmp -s "$ROOT/$f" "$PKG/$f" || die "$f differs from the local copy"
done

[[ -z "$(find "$PKG/build" -name '*.map' | head -n 1)" ]] || die "source maps shipped (they point at src/, which is not in the package)"

log "artifacts.js resolves both platforms from the installed path"
( cd "$WORK/app" && node --input-type=module - "$PKG" <<'NODE'
const pkg = process.argv[2];
const { pathToFileURL } = await import("node:url");
const { existsSync, realpathSync } = await import("node:fs");
const m = await import(pathToFileURL(`${pkg}/build/native/artifacts.js`).href);
const root = m.driversRoot();
const want = realpathSync(`${pkg}/build/drivers`);
if (!root || realpathSync(root) !== want) throw new Error(`driversRoot() = ${root}, expected ${want}`);
const ios = m.iosArtifact(), android = m.androidArtifact();
if (!ios) throw new Error("iosArtifact() returned undefined");
if (!android) throw new Error("androidArtifact() returned undefined");
for (const p of [ios.runnerApp, ios.hostApp, ios.xctestrun, android.appApk, android.testApk]) {
  if (!realpathSync(p).startsWith(want + "/") || !existsSync(p)) throw new Error(`artifact outside the installed package or missing: ${p}`);
}
if (ios.version !== android.version) throw new Error(`versions differ: ${ios.version} vs ${android.version}`);
console.error(`[pack-test] artifacts ok: ios ${ios.version} (${ios.runnerBundleId}), android ${android.version} (${android.appPackage})`);
NODE
) || die "installed artifacts.js did not resolve both platforms"

log "installed bin answers MCP initialize + tools/list"
BIN="$WORK/app/node_modules/.bin/react-native-eye"
[[ -x "$BIN" ]] || die "bin $BIN missing or not executable"
node - "$BIN" <<'NODE' || die "MCP smoke over stdio failed"
const { spawn } = require("child_process");
const bin = process.argv[2];
const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RNE_NATIVE_DRIVER: "off" } });
let buf = "", stderr = "";
const pending = new Map();
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const call = (id, method, params) => new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
const timer = setTimeout(() => { console.error("timeout; server stderr:\n" + stderr); child.kill("SIGKILL"); process.exit(1); }, 20000);
(async () => {
  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-test", version: "0" } });
  if (init.error || init.result?.serverInfo?.name !== "react-native-eye") throw new Error("bad initialize: " + JSON.stringify(init));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await call(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  if (list.error || !tools.some((t) => t.name === "ping")) throw new Error("bad tools/list: " + JSON.stringify(list).slice(0, 500));
  console.error(`[pack-test] MCP ok: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}, ${tools.length} tools`);
  clearTimeout(timer);
  child.stdin.end();
  const t = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.on("exit", () => { clearTimeout(t); process.exit(0); });
})().catch((e) => { console.error(e.message + "\nserver stderr:\n" + stderr); child.kill("SIGKILL"); process.exit(1); });
NODE

node - "$WORK/pack.json" <<'NODE'
const j = require(process.argv[2])[0];
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
console.log(`[pack-test] OK — ${j.filename}: tarball ${mb(j.size)} (${j.size} B), unpacked ${mb(j.unpackedSize)} (${j.unpackedSize} B), ${j.entryCount} files`);
NODE
