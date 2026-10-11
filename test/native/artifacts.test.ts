import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iosArtifact, androidArtifact, driversRoot } from "../../src/native/artifacts.js";

const MANIFEST = {
  version: "0.0.1-ab12cd34",
  sourceHash: "ab12cd34" + "0".repeat(56),
  builtAt: "2026-09-24T10:00:00.000Z",
  ios: {
    xcodeVersion: "26.2 (17C49)",
    runnerApp: "ios/RNERunnerUITests-Runner.app",
    hostApp: "ios/RNERunner.app",
    xctestrun: "ios/RNERunner.xctestrun",
    runnerBundleId: "dev.rneye.runnerUITests.xctrunner",
  },
};

const roots: string[] = [];

function makeRoot(opts: { manifest?: unknown; files?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "rne-drivers-"));
  roots.push(root);
  if (opts.manifest !== undefined) {
    writeFileSync(join(root, "manifest.json"), typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest));
  }
  mkdirSync(join(root, "ios"), { recursive: true });
  for (const f of opts.files ?? []) {
    if (f.endsWith(".app")) mkdirSync(join(root, f), { recursive: true });
    else writeFileSync(join(root, f), "");
  }
  return root;
}

const ALL_FILES = ["ios/RNERunnerUITests-Runner.app", "ios/RNERunner.app", "ios/RNERunner.xctestrun"];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("iosArtifact", () => {
  it("returns absolute paths, bundle id and version when the manifest and every file exist", () => {
    const root = makeRoot({ manifest: MANIFEST, files: ALL_FILES });
    expect(iosArtifact({ root })).toEqual({
      runnerApp: join(root, "ios/RNERunnerUITests-Runner.app"),
      hostApp: join(root, "ios/RNERunner.app"),
      xctestrun: join(root, "ios/RNERunner.xctestrun"),
      runnerBundleId: "dev.rneye.runnerUITests.xctrunner",
      version: "0.0.1-ab12cd34",
    });
  });

  it("returns undefined when there is no manifest", () => {
    const root = makeRoot({ files: ALL_FILES });
    expect(iosArtifact({ root })).toBeUndefined();
  });

  it("returns undefined when the manifest is not JSON", () => {
    const root = makeRoot({ manifest: "{ not json", files: ALL_FILES });
    expect(iosArtifact({ root })).toBeUndefined();
  });

  it("returns undefined when the manifest has no ios section (android-only build)", () => {
    const { ios: _ios, ...androidOnly } = MANIFEST;
    const root = makeRoot({ manifest: androidOnly, files: ALL_FILES });
    expect(iosArtifact({ root })).toBeUndefined();
  });

  it("returns undefined when the manifest names a file that is not on disk", () => {
    for (const missing of ALL_FILES) {
      const root = makeRoot({ manifest: MANIFEST, files: ALL_FILES.filter((f) => f !== missing) });
      expect(iosArtifact({ root }), `missing ${missing}`).toBeUndefined();
    }
  });

  it("returns undefined when the root directory does not exist", () => {
    expect(iosArtifact({ root: join(tmpdir(), "rne-drivers-does-not-exist-xyz") })).toBeUndefined();
  });
});

describe("driversRoot", () => {
  it("returns undefined or a directory that holds a manifest.json", () => {
    const r = driversRoot();
    if (r !== undefined) expect(existsSync(join(r, "manifest.json"))).toBe(true);
  });
});

const ANDROID = {
  jdkVersion: "21.0.6",
  compileSdk: 36,
  appApk: "android/rne-server.apk",
  testApk: "android/rne-server-test.apk",
  appPackage: "dev.rneye.server",
  testPackage: "dev.rneye.server.test",
  testRunner: "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
  testClass: "dev.rneye.server.DriverService#server",
  versionCode: 1,
};
const ANDROID_FILES = ["android/rne-server.apk", "android/rne-server-test.apk"];

function makeAndroidRoot(manifest: unknown, files: string[] = ANDROID_FILES): string {
  const root = makeRoot({ manifest });
  mkdirSync(join(root, "android"), { recursive: true });
  for (const f of files) writeFileSync(join(root, f), "");
  return root;
}

describe("androidArtifact", () => {
  it("returns absolute APK paths, packages, runner, class and version", () => {
    const root = makeAndroidRoot({ ...MANIFEST, android: ANDROID });
    expect(androidArtifact({ root })).toEqual({
      appApk: join(root, "android/rne-server.apk"),
      testApk: join(root, "android/rne-server-test.apk"),
      appPackage: "dev.rneye.server",
      testPackage: "dev.rneye.server.test",
      testRunner: "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
      testClass: "dev.rneye.server.DriverService#server",
      version: "0.0.1-ab12cd34",
    });
  });

  it("returns undefined for an ios-only manifest", () => {
    expect(androidArtifact({ root: makeAndroidRoot(MANIFEST) })).toBeUndefined();
  });

  it("returns undefined when an APK is missing (half-finished build)", () => {
    const root = makeAndroidRoot({ ...MANIFEST, android: ANDROID }, ["android/rne-server.apk"]);
    expect(androidArtifact({ root })).toBeUndefined();
  });

  it("returns undefined when a field is missing or not a string", () => {
    const { testClass: _drop, ...noClass } = ANDROID;
    expect(androidArtifact({ root: makeAndroidRoot({ ...MANIFEST, android: noClass }) })).toBeUndefined();
    expect(androidArtifact({ root: makeAndroidRoot({ ...MANIFEST, android: { ...ANDROID, testRunner: 7 } }) })).toBeUndefined();
  });

  it("ignores a devicePort left by a build from before the Unix-socket transport", () => {
    const root = makeAndroidRoot({ ...MANIFEST, android: { ...ANDROID, devicePort: 7311 } });
    expect(androidArtifact({ root })).not.toHaveProperty("devicePort");
  });

  it("returns undefined without a manifest", () => {
    expect(androidArtifact({ root: makeRoot({}) })).toBeUndefined();
  });

  it("does not disturb iosArtifact when both sections exist", () => {
    const root = makeAndroidRoot({ ...MANIFEST, android: ANDROID });
    for (const f of ALL_FILES) {
      if (f.endsWith(".app")) mkdirSync(join(root, f), { recursive: true });
      else writeFileSync(join(root, f), "");
    }
    expect(iosArtifact({ root })?.runnerBundleId).toBe("dev.rneye.runnerUITests.xctrunner");
    expect(androidArtifact({ root })?.appPackage).toBe("dev.rneye.server");
  });
});
