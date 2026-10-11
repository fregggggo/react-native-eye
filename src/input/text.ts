import { SAFE, MEASURER } from "../layout/runtimeSnippets.js";
import { SCENE_RANK } from "./focusedScreen.js";

export type InputTarget = { testID?: string; placeholder?: string; label?: string };

export type InputInfo = {
  testID?: string;
  placeholder?: string;
  label?: string;
  value?: string;
  controlled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The navigator scene the field sits in: `focused` when its screen is the one
   * on top of its navigator, `depth` its distance from that top (0 = topmost).
   * An app with no navigator reports `{ focused: true, depth: 0 }` — one screen,
   * and it is the one on screen. See `SCENE_RANK`.
   */
  scene: { focused: boolean; depth: number };
};

/**
 * A JS literal for an arbitrary value. JSON.stringify emits U+2028/U+2029 raw,
 * and those are not legal inside an ES5 string literal — typed text is
 * user-controlled, so this is not theoretical.
 */
function lit(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Shared by all three expressions: find every mounted TextInput, measure it,
 * and pick the one the caller meant.
 *
 * Deduplication is the whole reason this is not a one-liner. One <TextInput>
 * renders a chain — CssInterop.TextInput -> TextInput -> InternalTextInput ->
 * RCTSinglelineTextInputView — where every level's display name contains
 * "TextInput" and every level carries the same props object. Only the outermost
 * level that actually looks like an input is claimed, and its subtree is then
 * skipped, so one field is reported once. The "looks like an input" test exists
 * because a user-land wrapper called something like FormTextInputRow would
 * otherwise be claimed instead of the field it wraps, and its props have no
 * onChangeText to call.
 */
const COLLECT = `
    var fm = globalThis.nativeFabricUIManager;
    var walked = 0;
${SAFE}
${MEASURER}
${SCENE_RANK}

    function displayName(fiber) {
      var t = safe(function () { return fiber.type; });
      if (typeof t === "string") return t;
      if (!t) return "";
      var n = safe(function () { return t.displayName; });
      if (typeof n === "string") return n;
      n = safe(function () { return t.name; });
      if (typeof n === "string") return n;
      var r = safe(function () { return t.render; });
      if (r) {
        n = safe(function () { return r.displayName || r.name; });
        if (typeof n === "string") return n;
      }
      return "";
    }

    function looksLikeInput(p) {
      if (!p || typeof p !== "object") return false;
      if (safe(function () { return typeof p.onChangeText === "function"; }) === true) return true;
      if (safe(function () { return Object.prototype.hasOwnProperty.call(p, "value"); }) === true) return true;
      if (safe(function () { return Object.prototype.hasOwnProperty.call(p, "placeholder"); }) === true) return true;
      if (safe(function () { return Object.prototype.hasOwnProperty.call(p, "defaultValue"); }) === true) return true;
      return false;
    }

    // Stays inside the claimed subtree: the host view that can be measured is
    // three or four levels below the component that owns the props.
    function measurerIn(fiber, depth) {
      if (!fiber || depth > 12) return null;
      var m = measurer(safe(function () { return fiber.stateNode; }));
      if (m) return m;
      var c = safe(function () { return fiber.child; });
      while (c) {
        var d = measurerIn(c, depth + 1);
        if (d) return d;
        c = safe(function () { return c.sibling; });
      }
      return null;
    }

    function collectInputs(done) {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers || !hook.getFiberRoots) {
        done(null, "React DevTools hook not present — not a dev build, or the app has not rendered yet");
        return;
      }
      var found = [];

      // Siblings are iterated and only children recurse: a long form would
      // otherwise grow the stack by one frame per row.
      function walk(fiber, inside) {
        while (fiber) {
          walked++;
          var mine = false;
          var p = safe(function () { return fiber.memoizedProps; });
          if (!inside && displayName(fiber).indexOf("TextInput") >= 0 && looksLikeInput(p)) {
            mine = true;
            found.push({
              props: p,
              testID: safe(function () { return p.testID; }),
              placeholder: safe(function () { return p.placeholder; }),
              label: safe(function () { return p.accessibilityLabel; }),
              value: safe(function () { return p.value; }),
              controlled: safe(function () { return Object.prototype.hasOwnProperty.call(p, "value"); }) === true,
              // Computed here, while the fiber is in hand: the walk is the only
              // place that still knows where this input sits in the tree.
              scene: sceneRank(fiber),
              m: measurerIn(fiber, 0),
              x: 0, y: 0, w: 0, h: 0
            });
          }
          walk(safe(function () { return fiber.child; }), inside || mine);
          fiber = safe(function () { return fiber.sibling; });
        }
      }

      try {
        hook.renderers.forEach(function (_, id) {
          hook.getFiberRoots(id).forEach(function (r) { walk(r.current, false); });
        });
      } catch (e) {
        done(null, "fiber walk failed: " + String(e));
        return;
      }

      var expected = 0;
      for (var i = 0; i < found.length; i++) if (found[i].m) expected++;
      if (expected === 0) { done(found); return; }

      var got = 0;
      for (var j = 0; j < found.length; j++) {
        (function (rec) {
          if (!rec.m) return;
          var called = false;
          function once(r) {
            if (called) return;
            called = true;
            if (r) { rec.x = r.x; rec.y = r.y; rec.w = r.w; rec.h = r.h; }
            got++;
            if (got >= expected) done(found);
          }
          try {
            rec.m(function (x, y, w, h) {
              once(typeof x === "number" ? { x: x, y: y, w: w, h: h } : null);
            });
          } catch (e) { once(null); }
          setTimeout(function () { once(null); }, 400);
        })(found[j]);
      }
    }

    function strip(r) {
      return {
        testID: r.testID, placeholder: r.placeholder, label: r.label,
        value: r.value, controlled: r.controlled,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
        scene: { focused: r.scene.focused, depth: r.scene.depth }
      };
    }

    function describe(r) {
      if (r.placeholder) return 'placeholder "' + r.placeholder + '"';
      if (r.testID) return 'testID "' + r.testID + '"';
      if (r.label) return 'label "' + r.label + '"';
      return "an unlabelled input at " + Math.round(r.x) + "," + Math.round(r.y);
    }

    // Only said when a navigator was actually found: with one screen there is
    // nothing to disambiguate, and today's wording is already right.
    function whichScene(r) {
      if (!r.scene.known) return "";
      if (r.scene.focused && r.scene.depth === 0) return " (focused screen)";
      if (r.scene.depth === 1) return " (1 screen back)";
      if (r.scene.depth > 1) return " (" + r.scene.depth + " screens back)";
      return " (background screen)";
    }

    function names(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(describe(list[i]) + whichScene(list[i]));
      return out.join(", ");
    }

    // The screen the user is actually looking at. Field test: a stack with the
    // same screen pushed twice leaves two identical TextInputs mounted, both
    // measuring at the same coordinates — ranking by scene is the only thing
    // that tells them apart.
    function onTop(r) { return r.scene.focused === true && r.scene.depth === 0; }
    function rank(r) { return (r.scene.focused ? 0 : 1000) + r.scene.depth; }

    function bestRanked(list) {
      var i, b = rank(list[0]);
      for (i = 1; i < list.length; i++) if (rank(list[i]) < b) b = rank(list[i]);
      var out = [];
      for (i = 0; i < list.length; i++) if (rank(list[i]) === b) out.push(list[i]);
      return out;
    }

    function targetDesc(t) {
      if (t.placeholder !== undefined) return '"' + t.placeholder + '"';
      if (t.testID !== undefined) return '"' + t.testID + '"';
      if (t.label !== undefined) return '"' + t.label + '"';
      return JSON.stringify(t);
    }

    // "Visible" here means measured with a non-zero frame. A scrolled-away input
    // still counts: onChangeText drives it whether or not it is on screen, and
    // refusing one would be judgement the OS path does not apply either.
    function pick(recs, target) {
      var i, vis = [];
      for (i = 0; i < recs.length; i++) if (recs[i].w > 0 && recs[i].h > 0) vis.push(recs[i]);
      if (target) {
        var hits = [];
        for (i = 0; i < recs.length; i++) {
          var r = recs[i];
          var ok = true;
          if (target.testID !== undefined && r.testID !== target.testID) ok = false;
          if (target.placeholder !== undefined && r.placeholder !== target.placeholder) ok = false;
          if (target.label !== undefined && r.label !== target.label) ok = false;
          if (ok) hits.push(r);
        }
        if (!hits.length) {
          return { reason: "no text input matched " + JSON.stringify(target) +
            (recs.length ? " — mounted inputs: " + names(recs) : " — no text input is mounted") };
        }
        // Same target on two screens of the same stack: the one the user is
        // looking at wins outright, and only a genuine tie is still ambiguous.
        var top = bestRanked(hits);
        if (top.length > 1) {
          var where = !top[0].scene.known ? "" : (onTop(top[0]) ? " on the focused screen" : " on a background screen");
          return { reason: top.length + " text inputs matched " + JSON.stringify(target) + where +
            " — narrow it: " + names(top) };
        }
        var chosen = top[0];
        return {
          rec: chosen,
          note: hits.length > 1 && onTop(chosen)
            ? hits.length + " matched " + targetDesc(target) + "; chose the one on the focused screen"
            : undefined,
          // Nothing on the focused screen matched, so the caller is being given a
          // field it cannot see. Better than refusing — but it has to be told.
          background: chosen.scene.known && !onTop(chosen)
        };
      }
      // With no target, only the focused screen is counted: a field left mounted
      // on the screen underneath is not something the caller can be asked about.
      var focused = [];
      for (i = 0; i < vis.length; i++) if (onTop(vis[i])) focused.push(vis[i]);
      var hidden = vis.length - focused.length;
      if (focused.length === 1) {
        return {
          rec: focused[0],
          note: hidden
            ? "chose the only input on the focused screen; " + hidden +
              (hidden === 1 ? " more is" : " more are") + " on background screens"
            : undefined
        };
      }
      if (focused.length > 1) {
        return { reason: focused.length + " text inputs on " + (hidden ? "the focused screen" : "screen") +
          " — pass \`into\` with one of: " + names(focused) };
      }
      if (vis.length === 1) return { rec: vis[0], background: vis[0].scene.known };
      if (!vis.length) {
        return { reason: recs.length
          ? recs.length + " text inputs are mounted but none could be measured"
          : "no text input is mounted on this screen" };
      }
      return { reason: vis.length + " text inputs on screen — pass \`into\` with one of: " + names(vis) };
    }
`;

/**
 * The scene half of the answer, in the caller's own voice: `pick` knows *that*
 * the field it chose is not on the focused screen, only the caller knows whether
 * that was a write or a read. Undefined drops out of the JSON.
 */
const SCENE_NOTE = `
    function sceneNote(picked, verb) {
      if (!picked.background) return picked.note;
      var warn = verb + " a field on a background screen";
      return picked.note ? picked.note + "; " + warn : warn;
    }
`;

/**
 * All three expressions have the same shape: collect, then answer. Fabric calls
 * back synchronously, so the common case returns a string without a Promise at
 * all; Paper measures asynchronously and settles the Promise instead. The 900 ms
 * backstop is the same belt-and-braces `fastLayout` uses — a measurement callback
 * that never fires must not hang the tool.
 */
function expression(kind: "list" | "type" | "read", prelude: string, body: string): string {
  return `/* rne:${kind} */(function () {
${COLLECT}
${SCENE_NOTE}
${prelude}
    function finish(recs, err) {
${body}
    }
    var out = null;
    var settle = null;
    collectInputs(function (recs, err) {
      out = finish(recs, err);
      if (settle) settle(out);
    });
    if (out !== null) return out;
    return new Promise(function (resolve) {
      settle = resolve;
      setTimeout(function () {
        resolve(out !== null ? out : finish(null, "timed out measuring text inputs"));
      }, 900);
    });
  })()`;
}

export function listInputsExpression(): string {
  return expression(
    "list",
    "",
    `
      if (!recs) return JSON.stringify({ available: false, inputs: [], error: err });
      var list = [];
      for (var i = 0; i < recs.length; i++) list.push(strip(recs[i]));
      return JSON.stringify({
        available: list.length > 0,
        inputs: list,
        error: list.length > 0 ? undefined : "walked " + walked + " fibers, no TextInput component is mounted"
      });`,
  );
}

export function typeExpression(target: InputTarget | null, value: string): string {
  return expression(
    "type",
    `    var TARGET = ${lit(target)};
    var VALUE = ${lit(value)};`,
    `
      if (!recs) return JSON.stringify({ typed: false, reason: err });
      var picked = pick(recs, TARGET);
      if (!picked.rec) return JSON.stringify({ typed: false, reason: picked.reason });
      var rec = picked.rec;
      // An input with no value prop is not driven by onChangeText: React keeps the
      // text in the native view, and the handler would fire without changing it.
      // The caller falls back to the OS keyboard on this reason.
      if (!rec.controlled) {
        return JSON.stringify({ typed: false, matched: strip(rec), reason: "uncontrolled input — no value prop to drive" });
      }
      var h = safe(function () { return rec.props.onChangeText; });
      if (typeof h !== "function") {
        return JSON.stringify({ typed: false, matched: strip(rec), reason: "input has a value prop but no onChangeText handler" });
      }
      try { h(VALUE); }
      catch (e) { return JSON.stringify({ typed: false, matched: strip(rec), reason: "onChangeText threw: " + String(e) }); }
      return JSON.stringify({ typed: true, matched: strip(rec), note: sceneNote(picked, "typed into") });`,
  );
}

export function readInputExpression(target: InputTarget | null): string {
  return expression(
    "read",
    `    var TARGET = ${lit(target)};`,
    `
      if (!recs) return JSON.stringify({ found: false, reason: err });
      var picked = pick(recs, TARGET);
      if (!picked.rec) return JSON.stringify({ found: false, reason: picked.reason });
      var rec = picked.rec;
      if (!rec.controlled) {
        return JSON.stringify({ found: false, reason: "uncontrolled input — no value prop to read" });
      }
      var v = safe(function () { return rec.props.value; });
      return JSON.stringify({ found: true, value: v == null ? "" : String(v), note: sceneNote(picked, "read from") });`,
  );
}
