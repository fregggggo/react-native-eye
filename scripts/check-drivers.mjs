#!/usr/bin/env node
// Prepublish gate for the prebuilt native drivers (package.json "prepublishOnly").
//
//   node scripts/check-drivers.mjs            # checks the repo this script lives in
//
// Refuses to publish when build/drivers/ does not hold a complete, current build of
// native/ for BOTH platforms, or when build/ holds compiled output whose source is gone.
// Plain Node >= 18, no dependencies. The functions are exported for the unit tests.
//
// sourceHash is computed exactly as source_hash() in scripts/build-drivers.sh (the
// canonical definition — see the header comment there):
//   find native \( -type d \( -name build -o ... \) -prune \) \
//     -o \( -type f ! -name .DS_Store ! -name local.properties -print \)
//   | LC_ALL=C sort | while read f; do shasum -a 256 "$f"; done | shasum -a 256
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory names source_hash() prunes (at any depth under native/). */
export const PRUNED_DIRS = new Set(["build", ".build", ".gradle", ".kotlin", ".idea", "DerivedData", "xcuserdata", ".swiftpm"]);
/** File names source_hash() skips. */
export const SKIPPED_FILES = new Set([".DS_Store", "local.properties"]);
/** Paths under build/drivers/ written by build-drivers.sh, not by tsc. */
export const ARTIFACT_ENTRIES = ["ios", "android", "manifest.json"];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Repo-relative paths ("native/…") of the files source_hash() hashes, sorted bytewise.
 * Like `find` (no -L): symlinks are neither followed nor listed (a symlink is not -type f).
 */
export function listSourceFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (!PRUNED_DIRS.has(d.name)) walk(child);
      } else if (d.isFile() && !SKIPPED_FILES.has(d.name)) {
        out.push(child);
      }
    }
  };
  walk("native");
  return out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** One line of `shasum -a 256 <path>` output, including shasum's escaping of \ and newline. */
export function shasumLine(hex, path) {
  if (/[\\\n]/.test(path)) return `\\${hex}  ${path.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}\n`;
  return `${hex}  ${path}\n`;
}

/** sourceHash of <root>/native, identical to source_hash() in scripts/build-drivers.sh. */
export function sourceHash(root) {
  if (!existsSync(join(root, "native"))) throw new Error(`no native/ directory under ${root}`);
  let lines = "";
  for (const p of listSourceFiles(root)) {
    if (p.includes("\n")) throw new Error(`file name with a newline under native/: ${JSON.stringify(p)} — build-drivers.sh cannot hash it`);
    lines += shasumLine(sha256(readFileSync(join(root, p))), p);
  }
  return sha256(lines);
}

const MACHO_MAGICS = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"]);

function isMachO(file) {
  const buf = Buffer.alloc(4);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(fd);
  }
  return MACHO_MAGICS.has(buf.toString("hex"));
}

/** All regular files under dir (absolute paths); symlinks reported separately. */
function walkFiles(dir, files = [], links = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) links.push(p);
    else if (d.isDirectory()) walkFiles(p, files, links);
    else if (d.isFile()) files.push(p);
  }
  return { files, links };
}

function treeSize(path) {
  if (!existsSync(path)) return { bytes: 0, files: 0 };
  const st = lstatSync(path);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  const { files } = walkFiles(path);
  return { bytes: files.reduce((n, f) => n + statSync(f).size, 0), files: files.length };
}

// tsc output → the source extensions that produce it (declarationMap is off, but a
// stale .d.ts.map would still be an orphan, so it is recognised too).
const COMPILED = [
  [".d.ts.map", [".ts", ".tsx"]],
  [".d.ts", [".ts", ".tsx"]],
  [".js.map", [".ts", ".tsx"]],
  [".js", [".ts", ".tsx"]],
  [".d.mts", [".mts"]],
  [".mjs.map", [".mts"]],
  [".mjs", [".mts"]],
  [".d.cts", [".cts"]],
  [".cjs.map", [".cts"]],
  [".cjs", [".cts"]],
];

/**
 * Files in build/ that tsc would not produce from the current src/ — compiled output of a
 * deleted or renamed source, or anything else that landed there. The native artifacts
 * (build/drivers/{ios,android,manifest.json}) are excluded. Returns repo-relative paths.
 */
export function orphanBuildFiles(root) {
  const build = join(root, "build");
  if (!existsSync(build)) return [];
  const skip = new Set(ARTIFACT_ENTRIES.map((e) => join(build, "drivers", e)));
  const orphans = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (skip.has(p)) continue;
      if (d.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(build, p).split(sep).join("/");
      const kind = COMPILED.find(([ext]) => rel.endsWith(ext));
      const ok = kind && kind[1].some((srcExt) => existsSync(join(root, "src", rel.slice(0, -kind[0].length) + srcExt)));
      if (!ok) orphans.push(`build/${rel}`);
    }
  };
  walk(build);
  return orphans.sort();
}

const str = (v) => typeof v === "string" && v.length > 0;
const IOS_FILES = ["runnerApp", "hostApp", "xctestrun"];
const IOS_FIELDS = [...IOS_FILES, "runnerBundleId"];
const ANDROID_FILES = ["appApk", "testApk"];
const ANDROID_FIELDS = [...ANDROID_FILES, "appPackage", "testPackage", "testRunner", "testClass"];

/**
 * Runs every check against the repo at `root`. Never throws for a bad build; returns
 * { ok, errors: string[], summary } where summary describes what was found.
 */
export function checkDrivers(root) {
  const errors = [];
  const drivers = join(root, "build", "drivers");
  const manifestPath = join(drivers, "manifest.json");
  const summary = { version: undefined, sourceHash: undefined, ios: undefined, android: undefined };
  const fix = "run scripts/build-drivers.sh (both platforms) before publishing";

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let hash;
  try {
    hash = sourceHash(root);
  } catch (e) {
    errors.push(`cannot hash native/: ${e.message}`);
  }
  summary.sourceHash = hash;

  let manifest;
  if (!existsSync(manifestPath)) {
    errors.push(`build/drivers/manifest.json is missing — ${fix}`);
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest || typeof manifest !== "object") throw new Error("not a JSON object");
    } catch (e) {
      errors.push(`build/drivers/manifest.json is not valid JSON (${e.message}) — ${fix}`);
      manifest = undefined;
    }
  }

  if (manifest) {
    summary.version = manifest.version;
    if (hash && manifest.sourceHash !== hash) {
      errors.push(
        `build/drivers is stale: manifest sourceHash ${String(manifest.sourceHash).slice(0, 8)}… ≠ native/ hash ${hash.slice(0, 8)}… ` +
          `(native/ changed since the drivers were built) — ${fix}`,
      );
    }
    const expected = hash ? `${pkg.version}-${hash.slice(0, 8)}` : undefined;
    if (expected && manifest.version !== expected) {
      errors.push(`manifest version is ${JSON.stringify(manifest.version)}, expected "${expected}" (package.json version + sourceHash) — ${fix}`);
    }

    const platform = (name, fields, fileFields) => {
      const sec = manifest[name];
      if (!sec || typeof sec !== "object") {
        errors.push(`manifest has no "${name}" section — publishing needs both ios and android; ${fix}`);
        return false;
      }
      const missingFields = fields.filter((f) => !str(sec[f]));
      if (missingFields.length) errors.push(`manifest "${name}" section lacks ${missingFields.join(", ")} — ${fix}`);
      for (const f of fileFields) {
        if (!str(sec[f])) continue;
        const p = resolve(drivers, sec[f]);
        if (!existsSync(p)) errors.push(`manifest ${name}.${f} names build/drivers/${sec[f]}, which does not exist — ${fix}`);
      }
      return true;
    };

    if (platform("ios", IOS_FIELDS, IOS_FILES)) {
      summary.ios = treeSize(join(drivers, "ios"));
      // simctl launches the runner and host executables straight from the installed bundle:
      // every Mach-O in the bundles must keep its exec bit (tarballs and copies can drop it).
      for (const f of ["runnerApp", "hostApp"]) {
        const app = str(manifest.ios[f]) ? resolve(drivers, manifest.ios[f]) : undefined;
        if (!app || !existsSync(app)) continue;
        const { files, links } = walkFiles(app);
        const machos = files.filter(isMachO);
        const top = machos.filter((p) => dirname(p) === app);
        if (top.length === 0) errors.push(`ios.${f} (${manifest.ios[f]}) has no executable at the bundle root — ${fix}`);
        for (const p of machos) {
          if ((statSync(p).mode & 0o111) === 0) {
            errors.push(`${relative(root, p)} lost its exec bit (mode ${(statSync(p).mode & 0o777).toString(8)}) — ${fix}`);
          }
        }
        for (const l of links) errors.push(`${relative(root, l)} is a symlink; npm pack drops symlinks — ${fix}`);
      }
    }
    if (platform("android", ANDROID_FIELDS, ANDROID_FILES)) {
      summary.android = treeSize(join(drivers, "android"));
    }
  }

  const orphans = orphanBuildFiles(root);
  if (orphans.length) {
    const shown = orphans.slice(0, 10).map((o) => `    ${o}`).join("\n");
    const more = orphans.length > 10 ? `\n    … and ${orphans.length - 10} more` : "";
    errors.push(
      `${orphans.length} file(s) in build/ have no source in src/ (stale compiled output would ship):\n${shown}${more}\n` +
        `  delete them (keep build/drivers/ios, build/drivers/android, build/drivers/manifest.json) and run npm run build`,
    );
  }

  return { ok: errors.length === 0, errors, summary };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { ok, errors, summary } = checkDrivers(root);
  if (!ok) {
    console.error(`[check-drivers] FAILED — not publishable:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const plat = (name, s) => `${name} ${mb(s.bytes)} (${s.files} files)`;
  console.log(
    `[check-drivers] OK — drivers ${summary.version}: ${plat("ios", summary.ios)}, ${plat("android", summary.android)}; build/ has no orphans`,
  );
}

// Run as a script (not imported by the tests). realpath both sides: /var vs /private/var etc.
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) main();
