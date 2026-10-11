import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs script without type declarations
import { checkDrivers, orphanBuildFiles, sourceHash } from "../../scripts/check-drivers.mjs";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts/check-drivers.mjs");

/**
 * source_hash() exactly as scripts/build-drivers.sh defines it, lifted out of the script
 * text so the test follows the canonical definition if it ever changes.
 */
function bashSourceHashFn(): string {
  const text = readFileSync(join(REPO, "scripts/build-drivers.sh"), "utf8");
  const m = /^source_hash\(\) \{\n[\s\S]*?\n\}\n/m.exec(text);
  if (!m) throw new Error("source_hash() not found in scripts/build-drivers.sh");
  return m[0];
}

async function bashSourceHash(root: string): Promise<string> {
  const { stdout } = await run("bash", ["-c", `set -euo pipefail\n${bashSourceHashFn()}\nsource_hash`], {
    env: { ...process.env, ROOT: root },
    maxBuffer: 1 << 20,
  });
  return stdout.trim();
}

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const put = (root: string, rel: string, content: string | Buffer = rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

describe("sourceHash matches build-drivers.sh source_hash()", () => {
  it("on the real native/ tree", async () => {
    const js = sourceHash(REPO);
    expect(js).toMatch(/^[0-9a-f]{64}$/);
    expect(js).toBe(await bashSourceHash(REPO));
  }, 60_000);

  it("on a fixture exercising prunes, skips, symlinks and byte-order sorting", async () => {
    const root = tmp("rne-hash-");
    const files = [
      "native/a.txt", "native/B.txt", "native/_x", "native/-y", "native/a-b/c", "native/a/b", "native/a.b/c",
      "native/Zeta/é.swift", "native/deep/build.gradle.kts", "native/deep/build", // a FILE named build is kept
      "native/deep/build/out.class", "native/.build/x", "native/x/.gradle/y", "native/x/.kotlin/y",
      "native/.idea/y", "native/x/DerivedData/y", "native/p.xcodeproj/xcuserdata/u", "native/.swiftpm/z",
      "native/android/local.properties", "native/.DS_Store", "native/ios/.DS_Store",
      "native/back\\slash.txt",
    ];
    // "native/deep/build" cannot be both a file and a dir: keep the file, prune a sibling dir.
    for (const f of files.filter((f) => f !== "native/deep/build/out.class")) put(root, f);
    put(root, "native/deep2/build/out.class");
    put(root, "native/empty.bin", "");
    symlinkSync("a.txt", join(root, "native/link-to-file"));
    symlinkSync("a", join(root, "native/link-to-dir"));
    expect(sourceHash(root)).toBe(await bashSourceHash(root));
  }, 30_000);
});

// ---------------------------------------------------------------- fixture repo

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const EXECS = [
  "build/drivers/ios/RNERunnerUITests-Runner.app/RNERunnerUITests-Runner",
  "build/drivers/ios/RNERunnerUITests-Runner.app/PlugIns/RNERunnerUITests.xctest/RNERunnerUITests",
  "build/drivers/ios/RNERunner.app/RNERunner",
];

function makeRepo(): { root: string; manifest: any; writeManifest: (m: any) => void } {
  const root = tmp("rne-check-");
  put(root, "package.json", JSON.stringify({ name: "x", version: "1.2.3" }));
  put(root, "native/ios-runner/Runner.swift", "print(1)\n");
  put(root, "native/android-server/Server.kt", "fun main() {}\n");
  put(root, "src/index.ts", "");
  put(root, "src/drivers/ios.ts", "");
  for (const f of ["build/index.js", "build/index.js.map", "build/index.d.ts", "build/drivers/ios.js", "build/drivers/ios.d.ts"]) put(root, f);
  for (const f of EXECS) {
    put(root, f, MACHO);
    chmodSync(join(root, f), 0o755);
  }
  put(root, "build/drivers/ios/RNERunnerUITests-Runner.app/Info.plist");
  put(root, "build/drivers/ios/RNERunnerUITests-Runner.app/helper.js"); // inside artifacts: never an orphan
  put(root, "build/drivers/ios/RNERunner.xctestrun");
  put(root, "build/drivers/android/rne-server.apk", Buffer.alloc(1000));
  put(root, "build/drivers/android/rne-server-test.apk", Buffer.alloc(3000));
  const hash = sourceHash(root);
  const manifest = {
    version: `1.2.3-${hash.slice(0, 8)}`,
    sourceHash: hash,
    builtAt: "2026-09-30T00:00:00.000Z",
    ios: {
      xcodeVersion: "26.3 (17C529)",
      runnerApp: "ios/RNERunnerUITests-Runner.app",
      hostApp: "ios/RNERunner.app",
      xctestrun: "ios/RNERunner.xctestrun",
      runnerBundleId: "dev.rneye.runnerUITests.xctrunner",
    },
    android: {
      appApk: "android/rne-server.apk",
      testApk: "android/rne-server-test.apk",
      appPackage: "dev.rneye.server",
      testPackage: "dev.rneye.server.test",
      testRunner: "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
      testClass: "dev.rneye.server.DriverService#server",
      versionCode: 1002003,
    },
  };
  const writeManifest = (m: any) => put(root, "build/drivers/manifest.json", JSON.stringify(m));
  writeManifest(manifest);
  return { root, manifest, writeManifest };
}

describe("checkDrivers", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  const errors = () => {
    const r = checkDrivers(repo.root);
    expect(r.ok).toBe(false);
    return r.errors.join("\n");
  };

  it("passes a complete, current build and summarises it", () => {
    const r = checkDrivers(repo.root);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary.version).toBe(repo.manifest.version);
    expect(r.summary.android).toEqual({ bytes: 4000, files: 2 });
    expect(r.summary.ios.files).toBe(6);
  });

  it("fails when manifest.json is missing", () => {
    unlinkSync(join(repo.root, "build/drivers/manifest.json"));
    expect(errors()).toMatch(/manifest\.json is missing/);
  });

  it("fails when native/ changed since the build (sourceHash mismatch)", () => {
    put(repo.root, "native/ios-runner/Runner.swift", "print(2)\n");
    const e = errors();
    expect(e).toMatch(/build\/drivers is stale: manifest sourceHash/);
    expect(e).toMatch(/manifest version is/);
  });

  it("ignores changes under pruned dirs and skipped files", () => {
    put(repo.root, "native/android-server/app/build/out.apk", "x");
    put(repo.root, "native/android-server/local.properties", "sdk.dir=/x");
    put(repo.root, "native/.DS_Store", "x");
    expect(checkDrivers(repo.root).errors).toEqual([]);
  });

  it("fails when the version is not <package version>-<hash[0:8]>", () => {
    repo.writeManifest({ ...repo.manifest, version: "1.2.2-" + repo.manifest.sourceHash.slice(0, 8) });
    expect(errors()).toMatch(/manifest version is "1\.2\.2-[0-9a-f]{8}", expected "1\.2\.3-/);
  });

  it("fails when a platform section is missing", () => {
    const { android: _a, ...noAndroid } = repo.manifest;
    repo.writeManifest(noAndroid);
    expect(errors()).toMatch(/no "android" section — publishing needs both ios and android/);
    const { ios: _i, ...noIos } = repo.manifest;
    repo.writeManifest(noIos);
    expect(errors()).toMatch(/no "ios" section/);
  });

  it("fails when a platform section lacks a field", () => {
    repo.writeManifest({ ...repo.manifest, ios: { ...repo.manifest.ios, runnerBundleId: "" } });
    expect(errors()).toMatch(/"ios" section lacks runnerBundleId/);
  });

  it("fails when a file the manifest names is missing", () => {
    unlinkSync(join(repo.root, "build/drivers/android/rne-server-test.apk"));
    expect(errors()).toMatch(/android\.testApk names build\/drivers\/android\/rne-server-test\.apk, which does not exist/);
    rmSync(join(repo.root, "build/drivers/ios/RNERunner.xctestrun"));
    expect(errors()).toMatch(/ios\.xctestrun names/);
  });

  it("fails when a runner or host executable lost its exec bit", () => {
    chmodSync(join(repo.root, EXECS[0]), 0o644);
    chmodSync(join(repo.root, EXECS[2]), 0o644);
    const e = errors();
    expect(e).toMatch(/RNERunnerUITests-Runner\.app\/RNERunnerUITests-Runner lost its exec bit \(mode 644\)/);
    expect(e).toMatch(/RNERunner\.app\/RNERunner lost its exec bit/);
  });

  it("fails when an app bundle has no executable at its root", () => {
    unlinkSync(join(repo.root, EXECS[2]));
    expect(errors()).toMatch(/ios\.hostApp \(ios\/RNERunner\.app\) has no executable at the bundle root/);
  });

  it("fails when a bundle contains a symlink", () => {
    symlinkSync("RNERunner", join(repo.root, "build/drivers/ios/RNERunner.app/Current"));
    expect(errors()).toMatch(/is a symlink; npm pack drops symlinks/);
  });

  it("fails on orphan compiled output in build/", () => {
    put(repo.root, "build/tools/removed.js");
    put(repo.root, "build/tools/removed.d.ts");
    put(repo.root, "build/drivers/gone.js.map");
    put(repo.root, "build/stray.txt");
    expect(orphanBuildFiles(repo.root)).toEqual([
      "build/drivers/gone.js.map", "build/stray.txt", "build/tools/removed.d.ts", "build/tools/removed.js",
    ]);
    expect(errors()).toMatch(/4 file\(s\) in build\/ have no source in src\/[\s\S]*build\/tools\/removed\.js/);
  });

  it("CLI: exits 0 with an OK summary, 1 with every problem listed", async () => {
    mkdirSync(join(repo.root, "scripts"));
    copyFileSync(SCRIPT, join(repo.root, "scripts/check-drivers.mjs"));
    const ok = await run(process.execPath, [join(repo.root, "scripts/check-drivers.mjs")]);
    expect(ok.stdout).toMatch(/\[check-drivers\] OK — drivers 1\.2\.3-[0-9a-f]{8}: ios .* MB \(6 files\), android .* MB \(2 files\)/);

    put(repo.root, "build/old.js");
    unlinkSync(join(repo.root, "build/drivers/android/rne-server.apk"));
    const bad = await run(process.execPath, [join(repo.root, "scripts/check-drivers.mjs")]).then(
      () => undefined,
      (e: { code: number; stderr: string }) => e,
    );
    expect(bad?.code).toBe(1);
    expect(bad?.stderr).toMatch(/FAILED — not publishable/);
    expect(bad?.stderr).toMatch(/android\.appApk/);
    expect(bad?.stderr).toMatch(/build\/old\.js/);
  });
});
