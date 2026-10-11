#!/usr/bin/env bash
# Builds the react-native-eye native drivers and writes build/drivers/manifest.json.
#
#   scripts/build-drivers.sh            # every platform this script knows (ios, android;
#                                       # ios is skipped with a log line on non-macOS hosts)
#   scripts/build-drivers.sh ios        # only the iOS runner
#   scripts/build-drivers.sh android    # only the Android server
#
# Output (relative to the repo root):
#   build/drivers/ios/RNERunnerUITests-Runner.app   runner app, installable with `simctl install`
#   build/drivers/ios/RNERunner.app                 stub host app (required by a UI-test bundle)
#   build/drivers/ios/RNERunner.xctestrun            for the `xcodebuild test-without-building` fallback
#   build/drivers/android/rne-server.apk            app APK dev.rneye.server (IME, receiver, probe)
#   build/drivers/android/rne-server-test.apk       instrumentation APK dev.rneye.server.test (HTTP server)
#   build/drivers/manifest.json                     version, sourceHash, builtAt, per-platform section
#
# Driver version = <package.json version>-<first 8 hex chars of sourceHash>.
# sourceHash (canonical definition — prepublish checks must compute it the same way):
#   1. list every regular file under native/, pruning directories named build, .build,
#      .gradle, .kotlin, .idea, DerivedData, xcuserdata, .swiftpm and skipping files named
#      .DS_Store and local.properties;
#   2. sort the repo-relative paths bytewise (LC_ALL=C);
#   3. for each path emit the line "<sha256 hex of the file content>  <path>\n"
#      (exactly `shasum -a 256 <path>` output, two spaces);
#   4. sourceHash = sha256 hex of the concatenated lines.
#
# Requirements:
#   iOS:     macOS with Xcode (xcodebuild on PATH).
#   Android: JDK 17+ (`java` on PATH), ANDROID_HOME or ANDROID_SDK_ROOT (default
#            ~/Library/Android/sdk) with build-tools 36.x (aapt2, apksigner) and platform
#            android-36. Gradle comes from native/android-server/gradlew (8.13 wrapper).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/drivers"
CACHE="$ROOT/.cache/drivers"
ALL_PLATFORMS=(ios android)

log() { printf '[build-drivers] %s\n' "$*" >&2; }
die() { printf '[build-drivers] ERROR: %s\n' "$*" >&2; exit 1; }

source_hash() {
  (
    cd "$ROOT"
    find native \
      \( -type d \( -name build -o -name .build -o -name .gradle -o -name .kotlin -o -name .idea -o -name DerivedData -o -name xcuserdata -o -name .swiftpm \) -prune \) \
      -o \( -type f ! -name .DS_Store ! -name local.properties -print \) \
      | LC_ALL=C sort \
      | while IFS= read -r f; do shasum -a 256 "$f"; done
  ) | shasum -a 256 | cut -d' ' -f1
}

# ---------------------------------------------------------------- iOS
IOS_PROJECT="$ROOT/native/ios-runner/RNERunner.xcodeproj"
IOS_SCHEME="RNERunner"
IOS_RUNNER_APP="RNERunnerUITests-Runner.app"
IOS_HOST_APP="RNERunner.app"
IOS_RUNNER_BUNDLE_ID="dev.rneye.runnerUITests.xctrunner"
IOS_XCODE_VERSION=""

build_ios() {
  [[ "$(uname -s)" == "Darwin" ]] || die "the iOS runner builds only on macOS"
  command -v xcodebuild >/dev/null || die "xcodebuild not found — install Xcode and run xcode-select"
  [[ -d "$IOS_PROJECT" ]] || die "missing $IOS_PROJECT"

  local derived="$CACHE/ios-derived"
  local buildlog="$CACHE/ios-build.log"
  local products="$derived/Build/Products/Debug-iphonesimulator"
  local dest="$OUT/ios"
  mkdir -p "$CACHE"

  IOS_XCODE_VERSION="$(xcodebuild -version | awk 'NR==1{v=$2} /^Build version/{b=$3} END{printf "%s (%s)", v, b}')"
  log "iOS: Xcode $IOS_XCODE_VERSION"

  # Keep SourcePackages (FlyingFox checkout) between builds; always rebuild products.
  rm -rf "$derived/Build"

  log "iOS: resolving Swift packages"
  xcodebuild -resolvePackageDependencies \
    -project "$IOS_PROJECT" -scheme "$IOS_SCHEME" \
    -derivedDataPath "$derived" >"$buildlog" 2>&1 \
    || { tail -40 "$buildlog" >&2; die "package resolution failed (full log: $buildlog)"; }

  log "iOS: build-for-testing (x86_64 arm64, iOS Simulator) — log: $buildlog"
  xcodebuild build-for-testing \
    -project "$IOS_PROJECT" -scheme "$IOS_SCHEME" \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" \
    ARCHS="x86_64 arm64" ONLY_ACTIVE_ARCH=NO \
    >>"$buildlog" 2>&1 \
    || { grep -E 'error:|BUILD FAILED' "$buildlog" | tail -40 >&2; die "xcodebuild build-for-testing failed (full log: $buildlog)"; }

  [[ -d "$products/$IOS_RUNNER_APP" ]] || die "missing $products/$IOS_RUNNER_APP"
  [[ -d "$products/$IOS_HOST_APP" ]] || die "missing $products/$IOS_HOST_APP"
  local xctestrun
  xctestrun="$(find "$derived/Build/Products" -maxdepth 1 -name "${IOS_SCHEME}_*.xctestrun" | head -n 1)"
  [[ -n "$xctestrun" ]] || die "no ${IOS_SCHEME}_*.xctestrun in $derived/Build/Products"

  rm -rf "$dest"
  mkdir -p "$dest"
  ditto "$products/$IOS_RUNNER_APP" "$dest/$IOS_RUNNER_APP"
  ditto "$products/$IOS_HOST_APP" "$dest/$IOS_HOST_APP"
  # The apps sit directly in build/drivers/ios, not in Debug-iphonesimulator/.
  sed 's#__TESTROOT__/Debug-iphonesimulator#__TESTROOT__#g' "$xctestrun" >"$dest/RNERunner.xctestrun"
  plutil -lint "$dest/RNERunner.xctestrun" >/dev/null || die "rewritten xctestrun is not a valid plist"

  # Stamp the driver version into the runner app (Bundle.main of the running test), then
  # re-sign ad hoc because editing Info.plist invalidates the existing signature.
  local plist="$dest/$IOS_RUNNER_APP/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :RNEDriverVersion" "$plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :RNEDriverVersion string $VERSION" "$plist"
  codesign --force --sign - --timestamp=none --preserve-metadata=identifier,entitlements,flags \
    "$dest/$IOS_RUNNER_APP" 2>>"$buildlog" || die "codesign failed (log: $buildlog)"
  codesign --verify --deep --strict "$dest/$IOS_RUNNER_APP" || die "codesign --verify failed"

  local got
  got="$(/usr/libexec/PlistBuddy -c "Print :RNEDriverVersion" "$plist")"
  [[ "$got" == "$VERSION" ]] || die "RNEDriverVersion is '$got', expected '$VERSION'"
  local plugin="$dest/$IOS_RUNNER_APP/PlugIns/RNERunnerUITests.xctest/RNERunnerUITests"
  for arch in x86_64 arm64; do
    lipo -archs "$plugin" | tr ' ' '\n' | grep -qx "$arch" || die "$plugin lacks $arch"
  done
  log "iOS: done → $dest"
}

# ---------------------------------------------------------------- Android
ANDROID_DIR="$ROOT/native/android-server"
ANDROID_APP_PACKAGE="dev.rneye.server"
ANDROID_TEST_PACKAGE="dev.rneye.server.test"
ANDROID_SECTION=""

android_sdk() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  [[ -d "$sdk" ]] || die "Android SDK not found — set ANDROID_HOME"
  printf '%s' "$sdk"
}

version_code() {
  # major*1e6 + minor*1e3 + patch of the package version (pre-release suffix ignored), at least 1.
  node -e 'const [a,b,c]=process.argv[1].split(/[.-]/).map(n=>parseInt(n,10)||0);console.log(Math.max(1,a*1e6+b*1e3+c))' "$1"
}

build_android() {
  command -v java >/dev/null || die "java not found — install JDK 17+"
  local jv; jv="$(java -version 2>&1 | awk -F'"' '/version/{print $2; exit}')"
  [[ "${jv%%.*}" -ge 17 ]] 2>/dev/null || die "JDK 17+ required (found $jv)"
  local sdk; sdk="$(android_sdk)"
  local bt; bt="$(ls -1 "$sdk/build-tools" 2>/dev/null | LC_ALL=C sort -V | tail -n 1)"
  [[ -n "$bt" && -x "$sdk/build-tools/$bt/aapt2" ]] || die "no build-tools with aapt2 under $sdk/build-tools"
  [[ -d "$sdk/platforms/android-36" ]] || die "platform android-36 missing — sdkmanager 'platforms;android-36'"

  local code; code="$(version_code "$PKG_VERSION")"
  local buildlog="$CACHE/android-build.log"
  local dest="$OUT/android"
  mkdir -p "$CACHE"

  # AGP gives the test APK no versionName/versionCode and rejects placeholders in those
  # manifest attributes, so the test manifest is generated here with literal values —
  # outside native/, because writing the version there would change sourceHash.
  local test_manifest="$CACHE/android-test-manifest/AndroidManifest.xml"
  mkdir -p "$(dirname "$test_manifest")"
  cat >"$test_manifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    android:versionName="$VERSION" android:versionCode="$code" />
XML

  log "Android: JDK $jv, build-tools $bt, versionName $VERSION, versionCode $code — log: $buildlog"
  (
    cd "$ANDROID_DIR"
    ANDROID_HOME="$sdk" ./gradlew --no-daemon --console=plain \
      --project-cache-dir "$CACHE/android-gradle" \
      -PrneVersion="$VERSION" -PrneVersionCode="$code" -PrneTestManifest="$test_manifest" \
      clean :app:assembleDebug :app:assembleDebugAndroidTest
  ) >"$buildlog" 2>&1 || { grep -E 'e: |error:|FAILURE|What went wrong' -A3 "$buildlog" | tail -40 >&2; die "gradle build failed (full log: $buildlog)"; }

  local outs="$ANDROID_DIR/app/build/outputs/apk"
  rm -rf "$dest"; mkdir -p "$dest"
  cp "$outs/debug/app-debug.apk" "$dest/rne-server.apk"
  cp "$outs/androidTest/debug/app-debug-androidTest.apk" "$dest/rne-server-test.apk"

  local apk pkg badging
  for apk in rne-server.apk rne-server-test.apk; do
    [[ "$apk" == rne-server.apk ]] && pkg="$ANDROID_APP_PACKAGE" || pkg="$ANDROID_TEST_PACKAGE"
    badging="$("$sdk/build-tools/$bt/aapt2" dump badging "$dest/$apk" | head -n 1)"
    [[ "$badging" == *"name='$pkg'"* ]] || die "$apk: package is not $pkg ($badging)"
    [[ "$badging" == *"versionName='$VERSION'"* ]] || die "$apk: versionName is not $VERSION ($badging)"
    [[ "$badging" == *"versionCode='$code'"* ]] || die "$apk: versionCode is not $code ($badging)"
  done
  local s1 s2
  s1="$("$sdk/build-tools/$bt/apksigner" verify --print-certs "$dest/rne-server.apk" | awk '/SHA-256/{print $NF; exit}')"
  s2="$("$sdk/build-tools/$bt/apksigner" verify --print-certs "$dest/rne-server-test.apk" | awk '/SHA-256/{print $NF; exit}')"
  [[ -n "$s1" && "$s1" == "$s2" ]] || die "APK signers differ ($s1 vs $s2)"

  ANDROID_SECTION="$(node -e '
    const [jdk, code] = process.argv.slice(1);
    console.log(JSON.stringify({
      jdkVersion: jdk, compileSdk: 36,
      appApk: "android/rne-server.apk", testApk: "android/rne-server-test.apk",
      appPackage: "dev.rneye.server", testPackage: "dev.rneye.server.test",
      testRunner: "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
      testClass: "dev.rneye.server.DriverService#server",
      versionCode: Number(code),
    }))' "$jv" "$code")"
  log "Android: done → $dest ($(du -h "$dest/rne-server.apk" | cut -f1) + $(du -h "$dest/rne-server-test.apk" | cut -f1))"
}

# ---------------------------------------------------------------- manifest
write_manifest() {
  # $@ = platforms built in this run. Sections for platforms not built in this run are kept
  # only if the previous manifest had the same version (same sources); otherwise dropped.
  ANDROID_SECTION="$ANDROID_SECTION" node - "$OUT/manifest.json" "$VERSION" "$SOURCE_HASH" "$IOS_XCODE_VERSION" "$IOS_RUNNER_BUNDLE_ID" "$@" <<'NODE'
const fs = require("fs");
const [file, version, sourceHash, xcodeVersion, runnerBundleId, ...built] = process.argv.slice(2);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const manifest = { version, sourceHash, builtAt: new Date().toISOString() };
if (prev.version === version) {
  for (const p of ["ios", "android"]) if (prev[p] && !built.includes(p)) manifest[p] = prev[p];
}
if (built.includes("ios")) {
  manifest.ios = {
    xcodeVersion,
    runnerApp: "ios/RNERunnerUITests-Runner.app",
    hostApp: "ios/RNERunner.app",
    xctestrun: "ios/RNERunner.xctestrun",
    runnerBundleId,
  };
}
if (built.includes("android")) manifest.android = JSON.parse(process.env.ANDROID_SECTION);
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
NODE
  log "manifest → $OUT/manifest.json (version $VERSION)"
}

# ---------------------------------------------------------------- main
main() {
  local platforms=("$@")
  [[ ${#platforms[@]} -gt 0 ]] || platforms=("${ALL_PLATFORMS[@]}")

  command -v node >/dev/null || die "node not found"
  local pkg_version
  pkg_version="$(node -p "require('$ROOT/package.json').version")"
  SOURCE_HASH="$(source_hash)"
  VERSION="$pkg_version-${SOURCE_HASH:0:8}"
  PKG_VERSION="$pkg_version"
  log "driver version $VERSION"
  mkdir -p "$OUT"

  local built=()
  for p in "${platforms[@]}"; do
    case "$p" in
      ios)
        if [[ "$(uname -s)" != Darwin && $# -eq 0 ]]; then log "iOS: skipped (not macOS)"; continue; fi
        build_ios ;;
      android) build_android ;;
      *) die "unknown platform '$p' (known: ${ALL_PLATFORMS[*]})" ;;
    esac
    built+=("$p")
  done
  write_manifest ${built[@]+"${built[@]}"}
}

main "$@"
