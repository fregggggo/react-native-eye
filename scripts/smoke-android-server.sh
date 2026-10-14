#!/usr/bin/env bash
# Installs the built server on one device, starts it, exercises every route, types non-ASCII
# through the IME and restores the keyboard, and checks the security boundary (review I1/M1/M5):
# no TCP listener, another uid cannot connect to the socket or send the IME broadcast, HTTP
# guards. Usage: scripts/smoke-android-server.sh <serial>
set -euo pipefail
S="${1:?usage: $0 <serial>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$ROOT/build/drivers"
A() { adb -s "$S" "$@"; }
VERSION="$(node -p "require('$D/manifest.json').version")"
LOG="${TMPDIR:-/tmp}/rne-android-smoke-$S.log"

A install -r -t -d "$D/android/rne-server.apk" >/dev/null
A install -r -t -d "$D/android/rne-server-test.apk" >/dev/null
A shell dumpsys package dev.rneye.server | grep -q "versionName=$VERSION" || { echo "app versionName mismatch"; exit 1; }
A shell dumpsys package dev.rneye.server.test | grep -q "versionName=$VERSION" || { echo "test versionName mismatch"; exit 1; }

A shell am force-stop dev.rneye.server
API="$(A shell getprop ro.build.version.sdk | tr -d '\r')"; M=""; [[ "$API" -ge 26 ]] && M="-m"
# A random abstract socket name per start, as androidServer.ts does.
SOCK="rneye-$(node -p 'require("crypto").randomBytes(8).toString("hex")')"
A logcat -c
nohup adb -s "$S" shell "am instrument -w $M -e debug false -e class 'dev.rneye.server.DriverService#server' -e socket $SOCK dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner" >"$LOG" 2>&1 &
PORT="$(A forward tcp:0 "localabstract:$SOCK" | tr -d '\r')"
cleanup() { A forward --remove "tcp:$PORT" 2>/dev/null || true; }
trap cleanup EXIT
t0=$(date +%s)
until curl -fsS "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q "\"$VERSION\""; do
  (( $(date +%s) - t0 > 30 )) && { echo "server did not answer in 30s"; cat "$LOG"; exit 1; }
  sleep 0.25
done
echo "status ok after $(( $(date +%s) - t0 ))s on port $PORT -> localabstract:$SOCK (API $API)"
J() { curl -fsS -X POST -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:$PORT$1"; echo; }
# Hierarchy XML with the JSON escaping removed, so greps see plain attributes.
HX() { J /viewHierarchy '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hierarchy))'; }
step() { echo "== $*"; }

# NEW_TASK|CLEAR_TASK recreates the probe (fresh tap counter) without touching the server process.
A shell am start -W -f 0x10008000 -n dev.rneye.server/.ProbeActivity >/dev/null; sleep 1
step deviceInfo; curl -fsS "http://127.0.0.1:$PORT/deviceInfo"; echo
step viewHierarchy
H="$(HX)"; grep -q 'dev.rneye.server:id/probe_button' <<<"$H" || { echo "probe_button not in hierarchy"; exit 1; }
read -r CX CY < <(node -e '
  const h = process.argv[1];
  const m = h.match(/<node[^>]*resource-id="dev\.rneye\.server:id\/probe_button"[^>]*>/)[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  console.log(((+m[1] + +m[3]) >> 1) + " " + ((+m[2] + +m[4]) >> 1));' "$H")
echo "probe_button centre $CX,$CY"
step touch; J /touch "{\"x\":$CX,\"y\":$CY}"
grep -qF 'tapped 1' <<<"$(HX)" || { echo "tap not delivered"; exit 1; }
step "touch 800ms (long press)"; J /touch "{\"x\":$CX,\"y\":$CY,\"durationMs\":800}"
H="$(HX)"; grep -qF 'long-pressed' <<<"$H" || { echo "long press not delivered"; exit 1; }
step "toast in the hierarchy with non-empty bounds (review M3)"
TOAST=""
for i in 1 2 3; do
  TOAST="$(grep -oE '<node[^>]*text="rne probe toast"[^>]*>' <<<"$H" || true)"
  [[ -n "$TOAST" ]] && break
  sleep 0.3; H="$(HX)"
done
[[ -n "$TOAST" ]] || { echo "toast not in hierarchy"; exit 1; }
echo "$TOAST"
grep -q 'bounds="\[0,0\]\[0,0\]"' <<<"$TOAST" && { echo "toast has empty bounds"; exit 1; }
step "inputText ASCII"; J /inputText '{"text":"Hello 42!"}'
grep -qF 'Hello 42!' <<<"$(HX)" || { echo "ASCII text not typed"; exit 1; }
step "inputText non-ASCII -> 400"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"text":"こんにちは"}' "http://127.0.0.1:$PORT/inputText" | grep -q 400
step "POST without JSON content type -> 415"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "http://127.0.0.1:$PORT/touch" | grep -q 415
step "unknown route -> 404"
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/nope" | grep -q 404

# Raw requests (curl normalises what these need broken). Prints the status code. No
# half-close: adb tears the forwarded stream down on the host's FIN before the reply
# arrives; the server closes after one response.
RAW() { node -e '
  const s = require("net").connect(+process.argv[1], "127.0.0.1", () => s.write(process.argv[2].replace(/\\r\\n/g, "\r\n")));
  let d = ""; s.on("data", (b) => (d += b)).on("close", () => console.log(d.split(" ")[1] ?? "closed"));' "$PORT" "$1"; }
step "Host header not loopback -> 403 (DNS rebinding, review M5)"
[[ "$(RAW 'GET /status HTTP/1.1\r\nHost: evil.example:'"$PORT"'\r\n\r\n')" == 403 ]] || { echo "foreign Host accepted"; exit 1; }
[[ "$(RAW 'GET /status HTTP/1.1\r\n\r\n')" == 403 ]] || { echo "missing Host accepted"; exit 1; }
[[ "$(RAW 'GET /status HTTP/1.1\r\nHost: localhost:'"$PORT"'\r\n\r\n')" == 200 ]] || { echo "localhost Host refused"; exit 1; }
step "negative Content-Length -> 400, too many headers -> 431 (review M5)"
[[ "$(RAW 'POST /touch HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n')" == 400 ]] || { echo "negative Content-Length not 400"; exit 1; }
MANY="$(for i in $(seq 1 120); do printf 'X-%d: 1\\r\\n' "$i"; done)"
[[ "$(RAW "GET /status HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n${MANY}\\r\\n")" == 431 ]] || { echo "120 headers not 431"; exit 1; }

step "no TCP listener owned by the server's uid (review I1)"
UID_="$(A shell dumpsys package dev.rneye.server | grep -oE '(userId|appId)=[0-9]+' | head -n 1 | cut -d= -f2)"
TCPTAB="$(A shell cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr -d '\r')"
grep -q local_address <<<"$TCPTAB" || { echo "cannot read /proc/net/tcp"; exit 1; }
LISTEN="$(awk -v u="$UID_" '$4 == "0A" && $8 == u' <<<"$TCPTAB")"
[[ -n "$UID_" && -z "$LISTEN" ]] || { echo "uid ${UID_:-?} listens on TCP: $LISTEN"; exit 1; }
echo "uid $UID_: no TCP listener"
step "another uid cannot use the socket (review I1)"
A shell am start -W -f 0x10008000 -n dev.rneye.server/.ProbeActivity --es rne_connect "$SOCK" >/dev/null; sleep 2
CHECK="$(grep -oE '<node[^>]*resource-id="dev.rneye.server:id/probe_check"[^>]*>' <<<"$(HX)" | grep -oE ' text="[^"]*"' || true)"
echo "probe (app uid) ->$CHECK"
grep -q 'connect: ' <<<"$CHECK" || { echo "probe did not report its connect attempt"; exit 1; }
grep -q 'answered' <<<"$CHECK" && { echo "the server answered another app's uid"; exit 1; }
A logcat -d -s RNEye:W | grep -q 'refused a connection from uid' || { echo "no refusal in logcat"; exit 1; }
A logcat -d -s RNEye:W | grep 'refused a connection' | tail -n 1
step "another uid cannot send the IME broadcast (review M1)"
# The probe activity shares the receiver's uid, and Android never checks a component's
# permission against its own app, so the probe cannot test this. The receiver must declare
# DUMP (held by shell, not by apps), and a real foreign uid must be turned away.
BT="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/* | sort -V | tail -n 1)"
"$BT/aapt2" dump xmltree --file AndroidManifest.xml "$D/android/rne-server.apk" \
  | grep -A3 'E: receiver' | grep -q '"android.permission.DUMP"' || { echo "IME receiver does not require DUMP"; exit 1; }
echo "receiver requires android.permission.DUMP"
FOREIGN=""
for p in $(A shell pm list packages -3 | tr -d '\r' | sed 's/^package://' | grep -v '^dev\.rneye\.'); do
  A shell run-as "$p" id >/dev/null 2>&1 && { FOREIGN="$p"; break; }
done
if [[ -n "$FOREIGN" ]]; then
  OUT="$(A shell run-as "$FOREIGN" cmd activity broadcast --user 0 -f 0x20 -n dev.rneye.server/.receivers.UnicodeInputReceiver -a dev.rneye.server.ime.status | tr -d '\r')"
  echo "broadcast from $FOREIGN's uid -> $OUT"
  grep -q 'result=0' <<<"$OUT" || { echo "the IME receiver took a broadcast from another uid"; exit 1; }
else
  echo "no debuggable third-party app to borrow a uid from: only the manifest was checked"
fi
# The socket probe recreated the activity: type the ASCII prefix into the fresh field again.
A shell am start -W -f 0x10008000 -n dev.rneye.server/.ProbeActivity >/dev/null; sleep 1
J /inputText '{"text":"Hello 42!"}' >/dev/null

# IME round trip, the same steps androidIme.ts runs. The broadcast must be explicit (-n):
# since Android 8 an implicit broadcast never reaches a manifest-declared receiver of an app
# targeting API 26+, and `am broadcast` then just reports result=0.
step "IME: non-ASCII + emoji"
ORIG="$(A shell settings get secure default_input_method | tr -d '\r')"
restore() { A shell ime set "$ORIG" >/dev/null 2>&1 || true; }
trap 'restore; cleanup' EXIT
A shell ime enable dev.rneye.server/.input.RneInputMethodService >/dev/null
A shell ime set dev.rneye.server/.input.RneInputMethodService >/dev/null
ready=0
for i in $(seq 1 17); do
  A shell am broadcast -f 0x20 -n dev.rneye.server/.receivers.UnicodeInputReceiver -a dev.rneye.server.ime.status | grep -q 'result=-1' && { ready=1; break; }; sleep 0.3
done
[[ $ready == 1 ]] || { echo "IME never became ready"; exit 1; }
B64="$(printf '%s' ' こんにちは 👋' | base64 | tr '+/' '-_' | tr -d '=\n')"
A shell am broadcast -f 0x20 -n dev.rneye.server/.receivers.UnicodeInputReceiver -a dev.rneye.server.ime.commitText --es textBase64 "$B64" | grep -q 'result=-1' || { echo "IME commit failed"; exit 1; }
sleep 0.25
A shell ime set "$ORIG" >/dev/null
trap cleanup EXIT
[[ "$(A shell settings get secure default_input_method | tr -d '\r')" == "$ORIG" ]] || { echo "IME not restored"; exit 1; }
echo "keyboard restored to $ORIG"
# The dump's XmlSerializer writes a supplementary character (the emoji) as a numeric reference.
grep -qE 'text="Hello 42! こんにちは (👋|&#128075;)"' <<<"$(HX)" || { echo "Unicode not committed"; exit 1; }
step eraseText; J /eraseText '{"charactersToErase":3}'
step "pressKey back"; J /pressKey '{"key":"back"}'
step "pressKey bogus -> 400"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"key":"bogus"}' "http://127.0.0.1:$PORT/pressKey" | grep -q 400
step swipe; J /swipe '{"startX":700,"startY":2400,"endX":700,"endY":900,"durationMs":300}'
step screenshot
curl -fsS "http://127.0.0.1:$PORT/screenshot" -o "${TMPDIR:-/tmp}/rne-android-smoke.png"; file "${TMPDIR:-/tmp}/rne-android-smoke.png" | grep -q PNG
step isScreenStatic; J /isScreenStatic '{}'
echo "SMOKE OK (server left running; forward removed)"
