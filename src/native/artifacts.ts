import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Everything iosRunner needs from a build of native/ios-runner (absolute paths). */
export type IosArtifact = {
  runnerApp: string;
  hostApp: string;
  xctestrun: string;
  runnerBundleId: string;
  version: string;
};

type Manifest = {
  version?: unknown;
  ios?: { runnerApp?: unknown; hostApp?: unknown; xctestrun?: unknown; runnerBundleId?: unknown };
  android?: Record<string, unknown>;
};

/**
 * Where scripts/build-drivers.sh put its output. Two layouts reach this file:
 * - compiled/published: build/native/artifacts.js → build/drivers/
 * - tsx / vitest from source: src/native/artifacts.ts → ../../build/drivers/
 * A directory counts only if it holds manifest.json — from source the first
 * candidate resolves to src/drivers/, which exists but is TypeScript.
 */
export function driversRoot(): string | undefined {
  const candidates = [new URL("../drivers/", import.meta.url), new URL("../../build/drivers/", import.meta.url)];
  for (const url of candidates) {
    const dir = fileURLToPath(url);
    if (existsSync(join(dir, "manifest.json"))) return dir;
  }
  return undefined;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The iOS runner build, or undefined when there is no usable one: no
 * manifest, a manifest without an `ios` section (an Android-only build, for
 * example), or a manifest naming a file that is not on disk (a half-finished
 * build). The `android` section, if any, is ignored here (see
 * androidArtifact). `root` overrides the lookup for tests.
 */
export function iosArtifact(opts?: { root?: string }): IosArtifact | undefined {
  const root = opts?.root ?? driversRoot();
  if (!root) return undefined;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
  const ios = manifest.ios;
  if (!ios || !str(manifest.version) || !str(ios.runnerApp) || !str(ios.hostApp) || !str(ios.xctestrun) || !str(ios.runnerBundleId)) {
    return undefined;
  }
  const art: IosArtifact = {
    runnerApp: resolve(root, ios.runnerApp),
    hostApp: resolve(root, ios.hostApp),
    xctestrun: resolve(root, ios.xctestrun),
    runnerBundleId: ios.runnerBundleId,
    version: manifest.version,
  };
  if (![art.runnerApp, art.hostApp, art.xctestrun].every((p) => existsSync(p))) return undefined;
  return art;
}

/** Everything androidServer needs from a build of native/android-server (absolute APK paths). */
export type AndroidArtifact = {
  appApk: string;
  testApk: string;
  appPackage: string;
  testPackage: string;
  /** `<testPackage>/<runner class>`, as `am instrument` takes it. */
  testRunner: string;
  /** `<class>#<method>`, passed as `-e class`. */
  testClass: string;
  /** Both APKs carry it as versionName; /status answers it. */
  version: string;
};

/**
 * The Android server build, or undefined when there is no usable one (same
 * rules as iosArtifact: no manifest, no `android` section, a missing field, or
 * an APK that is not on disk).
 */
export function androidArtifact(opts?: { root?: string }): AndroidArtifact | undefined {
  const root = opts?.root ?? driversRoot();
  if (!root) return undefined;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
  const a = manifest.android;
  if (
    !a || !str(manifest.version) || !str(a.appApk) || !str(a.testApk) || !str(a.appPackage) ||
    !str(a.testPackage) || !str(a.testRunner) || !str(a.testClass)
  ) {
    return undefined;
  }
  const art: AndroidArtifact = {
    appApk: resolve(root, a.appApk),
    testApk: resolve(root, a.testApk),
    appPackage: a.appPackage,
    testPackage: a.testPackage,
    testRunner: a.testRunner,
    testClass: a.testClass,
    version: manifest.version,
  };
  if (![art.appApk, art.testApk].every((p) => existsSync(p))) return undefined;
  return art;
}
