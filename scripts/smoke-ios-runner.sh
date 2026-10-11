#!/usr/bin/env bash
# Smoke test for the iOS runner built by scripts/build-drivers.sh.
#
#   scripts/smoke-ios-runner.sh <udid> [port]
#
# Installs build/drivers/ios/RNERunnerUITests-Runner.app on the booted simulator <udid>,
# launches it with `simctl launch` (SIMCTL_CHILD_PORT), waits for GET /status, calls every
# route with curl and prints status code + time per call, types Cyrillic "Привет" into the
# Spotlight search field and checks the value through /viewHierarchy, then terminates the
# runner. Exit code 0 = all checks passed; 1 = a check failed; 2 = Cyrillic typing failed
# but everything else passed (see the plan's decision rule).
#
# Artifacts (responses, screenshots, runner console log) go to .cache/drivers/smoke/.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UDID="${1:-}"
[[ -n "$UDID" ]] || { echo "usage: $0 <udid> [port]" >&2; exit 1; }
PORT="${2:-$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
MANIFEST="$ROOT/build/drivers/manifest.json"
APP="$ROOT/build/drivers/ios/RNERunnerUITests-Runner.app"
BUNDLE="dev.rneye.runnerUITests.xctrunner"
OUT="$ROOT/.cache/drivers/smoke"
BASE="http://127.0.0.1:$PORT"
TEXT="Привет"

FAILS=0
CYRILLIC_OK=1
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
now_ms() { node -e 'console.log(Date.now())'; }
json() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)"; }

# call METHOD PATH [JSON_BODY] — prints one timing line; body saved to $OUT/<route>.out,
# HTTP code in $CODE, file in $BODY.
call() {
  local method="$1" path="$2" data="${3:-}" name
  name="$(echo "$path" | tr -dc 'A-Za-z')"
  BODY="$OUT/$name.out"
  local args=(-s -o "$BODY" -w '%{http_code} %{time_total} %{size_download}' -X "$method" --max-time 30)
  [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' --data-binary "$data")
  local res
  res="$(curl "${args[@]}" "$BASE$path")"
  CODE="${res%% *}"
  printf '  %-6s %-16s HTTP %s  %6ss  %8s bytes\n' "$method" "$path" "$CODE" "$(echo "$res" | cut -d' ' -f2)" "$(echo "$res" | cut -d' ' -f3)"
}

[[ -f "$MANIFEST" && -d "$APP" ]] || { echo "build first: scripts/build-drivers.sh ios" >&2; exit 1; }
xcrun simctl list devices booted | grep -q "$UDID" || { echo "simulator $UDID is not booted" >&2; exit 1; }
VERSION="$(json 'd.version' <"$MANIFEST")"
rm -rf "$OUT"; mkdir -p "$OUT"
echo "runner $VERSION on $UDID, port $PORT"

echo "== install + launch"
t0=$(now_ms)
xcrun simctl install "$UDID" "$APP" || { echo "simctl install failed" >&2; exit 1; }
t1=$(now_ms)
echo "  simctl install: $((t1 - t0)) ms"
installed="$(plutil -extract RNEDriverVersion raw "$(xcrun simctl get_app_container "$UDID" "$BUNDLE")/Info.plist")"
[[ "$installed" == "$VERSION" ]] && pass "installed RNEDriverVersion = $installed" || fail "installed RNEDriverVersion '$installed' != '$VERSION'"

SIMCTL_CHILD_PORT="$PORT" xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE" >"$OUT/runner-console.log" 2>&1 &
LAUNCH_PID=$!
cleanup() {
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  kill "$LAUNCH_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

status=""
for _ in $(seq 1 80); do          # 80 x 250 ms = 20 s, the same budget as src/native/iosRunner.ts
  status="$(curl -s --max-time 1 "$BASE/status" || true)"
  [[ -n "$status" ]] && break
  sleep 0.25
done
t2=$(now_ms)
[[ -n "$status" ]] || { fail "no answer on $BASE/status within 20 s (console: $OUT/runner-console.log)"; exit 1; }
echo "  launch → /status: $((t2 - t1)) ms"
echo "  /status → $status"
[[ "$(echo "$status" | json 'd.status')" == "ok" ]] && pass "status ok" || fail "status is not ok"
[[ "$(echo "$status" | json 'd.version')" == "$VERSION" ]] && pass "version matches manifest" || fail "version != $VERSION"

echo "== routes"
call GET /status
[[ "$CODE" == 200 ]] || fail "/status HTTP $CODE"

call GET /deviceInfo
if [[ "$CODE" == 200 ]]; then
  W="$(json 'd.widthPoints' <"$BODY")"; H="$(json 'd.heightPoints' <"$BODY")"
  WPX="$(json 'd.widthPixels' <"$BODY")"; HPX="$(json 'd.heightPixels' <"$BODY")"
  pass "deviceInfo $(cat "$BODY")"
else fail "/deviceInfo HTTP $CODE: $(cat "$BODY")"; W=402; H=874; WPX=0; HPX=0; fi

call POST /pressButton '{"button":"home"}'
[[ "$CODE" == 200 ]] && pass "pressButton home" || fail "/pressButton HTTP $CODE: $(cat "$BODY")"
sleep 1

call POST /viewHierarchy '{}'
if [[ "$CODE" == 200 ]] && [[ "$(json '!!d.axElement && typeof d.depth' <"$BODY")" == "number" ]]; then
  pass "viewHierarchy has axElement, depth $(json 'd.depth' <"$BODY")"
else fail "/viewHierarchy HTTP $CODE: $(head -c 300 "$BODY")"; fi

call GET /screenshot
cp "$BODY" "$OUT/home.png"
if [[ "$CODE" == 200 ]] && [[ "$(head -c 8 "$OUT/home.png" | xxd -p)" == "89504e470d0a1a0a" ]]; then
  PW="$(sips -g pixelWidth "$OUT/home.png" | awk '/pixelWidth/{print $2}')"
  PH="$(sips -g pixelHeight "$OUT/home.png" | awk '/pixelHeight/{print $2}')"
  [[ "$PW" == "$WPX" && "$PH" == "$HPX" ]] && pass "screenshot PNG ${PW}x${PH} = deviceInfo pixels" \
    || fail "screenshot ${PW}x${PH} != deviceInfo ${WPX}x${HPX}"
else fail "/screenshot HTTP $CODE or not a PNG"; fi

call GET /isScreenStatic
[[ "$CODE" == 200 ]] && pass "isScreenStatic $(tr -d ' \n' <"$BODY")" || fail "/isScreenStatic HTTP $CODE"

# Tap and long-press the status bar: harmless on the home screen.
call POST /touch "{\"x\":$((W / 2)),\"y\":8}"
[[ "$CODE" == 200 ]] && pass "touch" || fail "/touch HTTP $CODE: $(cat "$BODY")"
call POST /touch "{\"x\":$((W / 2)),\"y\":8,\"durationMs\":600}"
[[ "$CODE" == 200 ]] && pass "touch durationMs 600 (long press)" || fail "/touch long HTTP $CODE: $(cat "$BODY")"

echo "== Cyrillic typing (Spotlight search field)"
# A downward swipe in the middle of the home screen opens Spotlight with its search
# field focused and the keyboard up.
call POST /swipe "{\"startX\":$((W / 2)),\"startY\":$((H * 35 / 100)),\"endX\":$((W / 2)),\"endY\":$((H * 65 / 100)),\"durationMs\":300}"
[[ "$CODE" == 200 ]] && pass "swipe (opens Spotlight)" || fail "/swipe HTTP $CODE: $(cat "$BODY")"
sleep 1.5

call POST /inputText "{\"text\":\"$TEXT\"}"
[[ "$CODE" == 200 ]] && pass "inputText" || fail "/inputText HTTP $CODE: $(cat "$BODY")"
sleep 0.5
call POST /viewHierarchy '{}'
cp "$BODY" "$OUT/cyrillic-hierarchy.json"
call GET /screenshot
cp "$BODY" "$OUT/cyrillic.png"
FOUND="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const want = process.argv[2]; const hits = []; const fields = [];
  (function walk(e) {
    if (!e) return;
    if (e.value === want) hits.push(e.elementType);
    if ([45, 49, 52].includes(e.elementType)) fields.push(JSON.stringify(e.value ?? null));
    (e.children || []).forEach(walk);
  })(d.axElement);
  console.log(hits.length ? "hit type " + hits[0] : "miss; text fields: " + fields.join(", "));
' "$OUT/cyrillic-hierarchy.json" "$TEXT")"
if [[ "$FOUND" == hit* ]]; then
  pass "value == \"$TEXT\" ($FOUND)"
else
  CYRILLIC_OK=0
  echo "  FAIL  Cyrillic: no element with value \"$TEXT\" — $FOUND (see $OUT/cyrillic.png)"
fi

call POST /eraseText '{"charactersToErase":6}'
[[ "$CODE" == 200 ]] && pass "eraseText 6" || fail "/eraseText HTTP $CODE: $(cat "$BODY")"
call POST /pressKey '{"key":"space"}'
[[ "$CODE" == 200 ]] && pass "pressKey space" || fail "/pressKey HTTP $CODE: $(cat "$BODY")"
call POST /pressButton '{"button":"home"}'

echo "== error shapes"
call POST /touch '{"nope":1}'
[[ "$CODE" == 400 && "$(json 'd.code' <"$BODY")" == "precondition" ]] && pass "bad body → 400 precondition" \
  || fail "bad body → HTTP $CODE $(cat "$BODY")"
CT_CODE="$(curl -s -o "$OUT/textplain.out" -w '%{http_code}' -X POST --max-time 30 -H 'Content-Type: text/plain' \
  --data-binary '{"text":"x"}' "$BASE/inputText")"
[[ "$CT_CODE" == 415 ]] && pass "text/plain POST → 415 (nothing typed)" || fail "text/plain POST /inputText → HTTP $CT_CODE $(cat "$OUT/textplain.out")"
call POST /launchApp '{"bundleId":"com.apple.Preferences"}'
[[ "$CODE" == 404 ]] && pass "dropped route /launchApp → 404" || fail "/launchApp → HTTP $CODE"

echo "== stop"
xcrun simctl terminate "$UDID" "$BUNDLE" && pass "simctl terminate"
sleep 1
curl -s --max-time 1 "$BASE/status" >/dev/null && fail "runner still answers after terminate" || pass "runner gone"

echo
if [[ $FAILS -gt 0 ]]; then echo "RESULT: $FAILS check(s) failed"; exit 1; fi
if [[ $CYRILLIC_OK -eq 0 ]]; then echo "RESULT: all routes OK, Cyrillic typing FAILED"; exit 2; fi
echo "RESULT: all checks passed"
