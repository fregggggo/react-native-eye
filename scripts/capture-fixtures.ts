// Records a real fiber tree and a real `axe describe-ui` payload into
// test/fixtures/, so the walkers and classifiers can be run against shapes an
// actual app produced instead of shapes a test author imagined.
//
// Run:  ./node_modules/.bin/tsx scripts/capture-fixtures.ts --port 8081 [--device "iPhone 17 Pro"] [--force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Registry } from "../src/core/registry.js";
import { activeDriver } from "../src/drivers/resolve.js";
import { run, TIMEOUTS } from "../src/core/exec.js";
import { MEASURER } from "../src/layout/runtimeSnippets.js";

/**
 * Walks every fiber root and emits one record per fiber: a display name, a
 * whitelisted subset of props, whether each handler is a function, the measured
 * rect for host components, and the parent index. Children keep document order,
 * so parent + order is the whole child/sibling structure.
 *
 * Every read goes through safe(), and a style whose properties throw is recorded
 * AS a thrower (styleThrows: true) rather than dropped — reproducing that is the
 * entire point of the fixture.
 */
export function captureFiberExpression(maxNodes = 6000): string {
  return `(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) {
      return JSON.stringify({ ok: false, error: "React DevTools hook not present — not a dev build, or the app has not rendered yet" });
    }
    var fm = globalThis.nativeFabricUIManager;
    var MAX = ${maxNodes};
    var nodes = [];
    var pending = [];
    var truncated = false;

    ${MEASURER}

    function safe(fn) { try { return fn(); } catch (e) { return undefined; } }

    function displayName(fiber) {
      var t = safe(function () { return fiber.type; });
      if (typeof t === "string") return t;
      if (typeof t === "function") return String(safe(function () { return t.displayName || t.name; }) || "Anonymous");
      if (t && typeof t === "object") {
        // memo / forwardRef wrappers
        var d = safe(function () {
          return t.displayName || (t.render && t.render.displayName) || (t.render && t.render.name) ||
                 (t.type && (t.type.displayName || t.type.name));
        });
        return d ? String(d) : "Object";
      }
      if (t === null || t === undefined) return "Root";
      return String(typeof t);
    }

    // Styles are read one property at a time and never spread: an Animated /
    // Reanimated style object throws when treated as a plain object. Arrays are
    // flattened last-wins, which is StyleSheet.flatten's own rule.
    function styleInto(rec, st, depth) {
      if (!st || depth > 3) return;
      if (Array.isArray(st)) {
        for (var i = 0; i < st.length; i++) styleInto(rec, st[i], depth + 1);
        return;
      }
      if (typeof st !== "object") return;
      var d, o, threw = false;
      try { d = st.display; } catch (e) { threw = true; }
      try { o = st.opacity; } catch (e) { threw = true; }
      if (threw) rec.styleThrows = true;
      if (typeof d === "string") rec.styleDisplay = d;
      if (typeof o === "number") rec.styleOpacity = o;
    }

    function projectProps(fiber) {
      var rec = {};
      var p = safe(function () { return fiber.memoizedProps; });
      if (!p || typeof p !== "object") return rec;
      function str(k) { var v = safe(function () { return p[k]; }); if (typeof v === "string") rec[k] = v; }
      function bool(k) { var v = safe(function () { return p[k]; }); if (typeof v === "boolean") rec[k] = v; }
      function num(k) { var v = safe(function () { return p[k]; }); if (typeof v === "number") rec[k] = v; }
      function isFn(k) { return typeof safe(function () { return p[k]; }) === "function"; }

      str("testID"); str("placeholder"); str("accessibilityLabel"); str("accessibilityRole");
      str("importantForAccessibility"); str("display");
      bool("accessibilityElementsHidden"); bool("focused");
      num("activityState"); num("index");

      var ah = safe(function () { return p["aria-hidden"]; });
      if (typeof ah === "boolean") rec.ariaHidden = ah;
      var ni = safe(function () { return p.navigationState && p.navigationState.index; });
      if (typeof ni === "number") rec.navigationIndex = ni;

      var ch = safe(function () { return p.children; });
      if (typeof ch === "string") rec.childrenText = ch;
      else if (typeof ch === "number") rec.childrenText = String(ch);

      // props.style may itself be a throwing getter; safe() would hide that as
      // "absent", and absent is not what we want to record.
      var st, styleThrew = false;
      try { st = p.style; } catch (e) { styleThrew = true; }
      if (styleThrew) rec.styleThrows = true; else styleInto(rec, st, 0);

      var hs = ["onPress", "onLongPress", "onClick", "onChangeText", "onStartShouldSetResponder"];
      for (var i = 0; i < hs.length; i++) if (isFn(hs[i])) rec[hs[i]] = true;

      if (safe(function () { return Object.prototype.hasOwnProperty.call(p, "value"); }) === true) {
        rec.hasValue = true;
        var v = safe(function () { return p.value; });
        if (typeof v === "string" || typeof v === "number") rec.value = String(v);
      }
      return rec;
    }

    // Siblings are iterated, only children recurse: a long list would otherwise
    // grow the stack by one frame per row.
    function walk(fiber, parent) {
      while (fiber) {
        if (nodes.length >= MAX) { truncated = true; return; }
        var rec = {
          i: nodes.length, parent: parent, name: displayName(fiber),
          host: typeof fiber.type === "string", props: projectProps(fiber)
        };
        nodes.push(rec);
        var m = measurer(fiber.stateNode);
        if (m) pending.push({ rec: rec, m: m });
        walk(fiber.child, rec.i);
        fiber = fiber.sibling;
      }
    }

    try {
      hook.renderers.forEach(function (_, id) {
        hook.getFiberRoots(id).forEach(function (r) { walk(r.current, -1); });
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: "fiber walk failed: " + String(e) });
    }

    var expected = pending.length, got = 0, settle = null;
    function onOne() { got++; if (got >= expected && settle) settle(); }
    function r2(n) { return Math.round(n * 100) / 100; }
    function build() {
      return JSON.stringify({
        ok: true, fabric: !!fm, fibers: nodes.length, measured: pending.length,
        truncated: truncated, nodes: nodes
      });
    }

    for (var i = 0; i < pending.length; i++) {
      (function (e) {
        var done = false;
        function once(r) {
          if (done) return;
          done = true;
          if (r) e.rec.rect = { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) };
          onOne();
        }
        try { e.m(function (x, y, w, h) { once(typeof x === "number" ? { x: x, y: y, w: w, h: h } : null); }); }
        catch (err) { once(null); }
        setTimeout(function () { once(null); }, 800);
      })(pending[i]);
    }

    if (got >= expected) return build();
    return new Promise(function (resolve) {
      settle = function () { resolve(build()); };
      setTimeout(function () { resolve(build()); }, 1500);
    });
  })()`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const outDir = resolvePath(process.cwd(), arg("out") ?? "test/fixtures");
const force = flag("force");
const port = arg("port") ? Number(arg("port")) : undefined;
const device = arg("device");
const only = arg("only");
const maxNodes = Number(arg("max-nodes") ?? 6000);

/**
 * A committed fixture is evidence; silently replacing it during an unrelated run
 * would make every test that consumes it mean something different without anyone
 * deciding so. Overwriting is therefore always deliberate.
 */
function writeFixture(file: string, payload: unknown): void {
  const path = resolvePath(outDir, file);
  const body = JSON.stringify(payload);
  if (existsSync(path) && !force) {
    throw new Error(
      `${path} already exists — refusing to overwrite. Re-run with --force if you mean to replace the recorded fixture, ` +
        `and expect test/layout/__snapshots__/fixtures.test.ts.snap to need -u afterwards.`,
    );
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, body + "\n");
  console.log(`wrote ${path} (${Math.round(body.length / 1024)} KB)`);
}

async function captureFiberTree(): Promise<void> {
  const registry = new Registry();
  const conn = await registry.connect({ port, device });
  try {
    const raw = await conn.evaluate(captureFiberExpression(maxNodes), { timeoutMs: 30_000 });
    const payload = JSON.parse(String(raw));
    if (!payload.ok) throw new Error(`fiber capture failed: ${payload.error}`);
    if (payload.truncated) console.warn(`WARNING: tree truncated at ${maxNodes} fibers — pass --max-nodes to raise it`);
    writeFixture("fiber-tree.json", {
      meta: {
        capturedAt: new Date().toISOString(),
        app: conn.meta.title,
        appId: conn.meta.appId ?? null,
        device: conn.meta.deviceName ?? null,
        port: conn.meta.port,
        fabric: payload.fabric,
        fibers: payload.fibers,
        measured: payload.measured,
        truncated: payload.truncated,
      },
      nodes: payload.nodes,
    });
  } finally {
    registry.reset();
  }
}

async function captureDescribeUi(): Promise<void> {
  const { driver, udid, name } = await activeDriver({ device });
  if (driver.platform !== "ios") {
    throw new Error(
      `describe-ui is an iOS fixture, but the resolved device is ${driver.platform} (${name}). ` +
        `Pass --only fiber, or --device <ios simulator>.`,
    );
  }
  const { stdout } = await run("axe", ["describe-ui", "--udid", udid], {
    timeoutMs: TIMEOUTS.layout,
    hint: "axe describe-ui is slow on complex screens and while animations are running.",
  });
  writeFixture("describe-ui.json", {
    meta: { capturedAt: new Date().toISOString(), device: name, udid, bytes: stdout.length },
    tree: JSON.parse(stdout),
  });
}

async function main(): Promise<void> {
  if (only !== "describe") await captureFiberTree();
  if (only !== "fiber") await captureDescribeUi();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
