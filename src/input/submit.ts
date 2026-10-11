// Evaluated inside the app runtime over CDP. Fires a TextInput's own submit
// handlers — the one interaction that had no route at all.
//
// Why this exists: `onSubmitEditing` is reachable only from the OS keyboard's
// return key, and driving the keyboard means a real touch, measured at 17-30s
// per event on a foregrounded app. A search field whose query only runs on
// submit was therefore untestable at any useful speed.
//
// The locating half is deliberately a copy of text.ts's, not an import: the two
// files are owned separately and a shared private helper would couple their
// release cycles. The duplication is the same shape of fiber walk, with one
// addition text.ts has no use for — which input holds focus.
import { SAFE, MEASURER } from "../layout/runtimeSnippets.js";
import type { InputTarget } from "./text.js";

export type SubmitResult =
  | { submitted: true; field: string; handlers: string[]; note?: string }
  | { submitted: false; field?: string; handlers?: string[]; reason: string };

/**
 * JSON.stringify leaves U+2028/U+2029 raw, and those are line terminators in an
 * ES5 program — a placeholder containing one would turn the interpolated
 * snippet into a syntax error on the device. The pattern is built from code
 * points so this file holds no invisible separators of its own.
 */
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function lit(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v).replace(LINE_SEPARATORS, function (c) {
    return "\\u" + c.charCodeAt(0).toString(16);
  });
}

/**
 * Fires the submit handlers of one TextInput, in the order RN's own return key
 * fires them.
 *
 * Target resolution matches `type_text` exactly — testID, placeholder or
 * accessibilityLabel — so the two tools never disagree about which field a
 * selector means. With no target and more than one field on screen it prefers
 * the focused one instead of refusing: submit follows typing, and the field
 * just typed into is the focused one.
 */
export function submitExpression(target: InputTarget | null): string {
  return `/* rne:submit */(function () {
    var fm = globalThis.nativeFabricUIManager;
    var TARGET = ${lit(target)};

${SAFE}
${MEASURER}

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

    // One <TextInput> renders a chain of four fibers that all carry the same
    // props and all have "TextInput" in their name; only the outermost level
    // that looks like an input is claimed, and its subtree is then skipped.
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

    // Focus is not a prop. RN's TextInput.State.currentlyFocusedInput() returns
    // the *instance*, and the instance is what answers isFocused() — on a
    // Fabric host under stateNode.canonical.publicInstance, on Paper on the
    // host component itself, and on the composite class when a ref holds it.
    // Reading it through the fiber avoids depending on Metro's module registry,
    // whose ids change with every bundle.
    function instFocus(inst) {
      if (!inst) return null;
      if (safe(function () { return typeof inst.isFocused; }) !== "function") return null;
      var v = safe(function () { return inst.isFocused(); });
      return typeof v === "boolean" ? v : null;
    }

    function focusIn(fiber, depth) {
      if (!fiber || depth > 12) return null;
      var sn = safe(function () { return fiber.stateNode; });
      var f = instFocus(sn);
      if (f !== null) return f;
      if (sn) {
        f = instFocus(safe(function () { return sn.canonical && sn.canonical.publicInstance; }));
        if (f !== null) return f;
      }
      var ref = safe(function () { return fiber.ref; });
      if (ref && typeof ref === "object") {
        f = instFocus(safe(function () { return ref.current; }));
        if (f !== null) return f;
      }
      var c = safe(function () { return fiber.child; });
      while (c) {
        var d = focusIn(c, depth + 1);
        if (d !== null) return d;
        c = safe(function () { return c.sibling; });
      }
      return null;
    }

    // The native tag the app sees in e.nativeEvent.target. Best effort: a
    // handler that reads it is rare, and an undefined tag is closer to the
    // truth than an invented one.
    function tagIn(fiber, depth) {
      if (!fiber || depth > 12) return undefined;
      var sn = safe(function () { return fiber.stateNode; });
      if (sn) {
        var t = safe(function () { return sn.canonical && sn.canonical.nativeTag; });
        if (typeof t === "number") return t;
        t = safe(function () { return sn._nativeTag; });
        if (typeof t === "number") return t;
      }
      var c = safe(function () { return fiber.child; });
      while (c) {
        var d = tagIn(c, depth + 1);
        if (d !== undefined) return d;
        c = safe(function () { return c.sibling; });
      }
      return undefined;
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
          var mine = false;
          var p = safe(function () { return fiber.memoizedProps; });
          if (!inside && displayName(fiber).indexOf("TextInput") >= 0 && looksLikeInput(p)) {
            mine = true;
            found.push({
              props: p,
              testID: safe(function () { return p.testID; }),
              placeholder: safe(function () { return p.placeholder; }),
              label: safe(function () { return p.accessibilityLabel; }),
              focused: focusIn(fiber, 0) === true,
              tag: tagIn(fiber, 0),
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

    function describe(r) {
      if (r.placeholder) return 'placeholder "' + r.placeholder + '"';
      if (r.testID) return 'testID "' + r.testID + '"';
      if (r.label) return 'label "' + r.label + '"';
      return "an unlabelled input at " + Math.round(r.x) + "," + Math.round(r.y);
    }

    function names(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(describe(list[i]));
      return out.join(", ");
    }

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
        if (hits.length > 1) {
          return { reason: hits.length + " text inputs matched " + JSON.stringify(target) +
            " — narrow it: " + names(hits) };
        }
        return { rec: hits[0] };
      }
      if (vis.length === 1) return { rec: vis[0] };
      // More than one field and no target: the focused one is the field the
      // return key would have submitted, which is the whole point of the
      // fallback — an agent that just typed does not have to name the field
      // twice. Two focused inputs is impossible on a real screen, so it is
      // treated as no answer rather than a guess.
      var foc = [];
      for (i = 0; i < recs.length; i++) if (recs[i].focused) foc.push(recs[i]);
      if (foc.length === 1) return { rec: foc[0] };
      if (!vis.length) {
        return { reason: recs.length
          ? recs.length + " text inputs are mounted but none could be measured"
          : "no text input is mounted on this screen" };
      }
      return { reason: vis.length + " text inputs on screen and none holds focus — pass \`into\` with one of: " + names(vis) };
    }

    function fire(h, txt, tag) {
      h({ nativeEvent: { text: txt, target: tag } });
    }

    function finish(recs, err) {
      if (!recs) return JSON.stringify({ submitted: false, reason: err });
      var picked = pick(recs, TARGET);
      if (!picked.rec) return JSON.stringify({ submitted: false, reason: picked.reason });
      var rec = picked.rec;
      var p = rec.props;
      var field = describe(rec);

      var onSubmit = safe(function () { return p.onSubmitEditing; });
      if (typeof onSubmit !== "function") {
        // Not a driver failure and not a bug here: a field with no submit
        // handler simply does nothing when the return key is pressed, and
        // saying which field it was is more useful than a generic refusal.
        return JSON.stringify({ submitted: false, field: field, reason: "field has no onSubmitEditing handler" });
      }

      // The text RN would put in the event: the controlled value, or the
      // uncontrolled field's initial one. An app that reads its own state
      // ignores this; one that reads e.nativeEvent.text must still work.
      var v = safe(function () { return p.value; });
      if (v === undefined || v === null) v = safe(function () { return p.defaultValue; });
      var txt = v === undefined || v === null ? "" : String(v);

      var fired = [];
      try { fire(onSubmit, txt, rec.tag); }
      catch (e) {
        return JSON.stringify({ submitted: false, field: field, reason: "onSubmitEditing threw: " + String(e) });
      }
      fired.push("onSubmitEditing");

      var note;
      var onEnd = safe(function () { return p.onEndEditing; });
      if (typeof onEnd === "function") {
        try { fire(onEnd, txt, rec.tag); fired.push("onEndEditing"); }
        // The submit already landed, so a failure below it is a note, not a
        // failed submit — reporting it as one would make the caller retry a
        // handler that has already run.
        catch (e2) { note = "onEndEditing threw: " + String(e2); }
      }

      // RN blurs a single-line field on submit unless blurOnSubmit is
      // explicitly false, which is how a chat composer keeps the keyboard up.
      if (safe(function () { return p.blurOnSubmit; }) !== false) {
        var onBlur = safe(function () { return p.onBlur; });
        if (typeof onBlur === "function") {
          try { fire(onBlur, txt, rec.tag); fired.push("onBlur"); }
          catch (e3) { if (!note) note = "onBlur threw: " + String(e3); }
        }
      }
      return JSON.stringify({ submitted: true, field: field, handlers: fired, note: note });
    }

    // Fabric measures synchronously, so the common case returns a string with
    // no Promise at all; Paper settles the Promise instead. The 900 ms backstop
    // is the same belt-and-braces fastLayout uses.
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
