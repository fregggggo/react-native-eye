import { describe, it, expect } from "vitest";
import { SCENE_RANK } from "../../src/input/focusedScreen.js";
import { SAFE } from "../../src/layout/runtimeSnippets.js";
import { makeRuntime } from "../helpers/rnRuntime.js";
import { linkParents, fabricFiber, type NodeSpec } from "../helpers/fiberTree.js";

type Rank = { focused: boolean; depth: number; known: boolean };

/**
 * Ranks every fiber carrying a `__mark` prop, through the same upward walk the
 * input expressions run. The mark stands in for a TextInput: what is under test
 * is which scene a fiber belongs to, not how the fiber was found.
 */
function ranks(spec: NodeSpec): Record<string, Rank> {
  const runtime = makeRuntime({ __root: linkParents(fabricFiber(spec)) });
  return JSON.parse(
    runtime.evaluate(`(function () {
${SAFE}
${SCENE_RANK}
      var out = {};
      function walk(f) {
        while (f) {
          var p = f.memoizedProps;
          if (p && p.__mark) out[p.__mark] = sceneRank(f);
          walk(f.child);
          f = f.sibling;
        }
      }
      walk(globalThis.__root);
      return JSON.stringify(out);
    })()`) as string,
  );
}

const leaf = (mark: string): NodeSpec => ({ type: "RCTView", props: { __mark: mark } });

describe("sceneRank", () => {
  it("calls a fiber with no navigator above it the focused screen", () => {
    // No navigator means one screen, and it is the one the user is looking at.
    // Reporting it unknown keeps every single-screen app on today's behaviour.
    expect(ranks({ type: "RCTView", children: [leaf("only")] }).only).toEqual({
      focused: true,
      depth: 0,
      known: false,
    });
  });

  it("ranks native-stack screens by activityState (2 = on top)", () => {
    // Field test: pushing the same screen twice leaves both mounted, both
    // measuring at the same coordinates. activityState is the only signal that
    // tells the live one from the one underneath it.
    const out = ranks({
      type: "RNSScreenStack",
      children: [
        { type: "RNSScreen", props: { activityState: 1 }, children: [leaf("under")] },
        { type: "RNSScreen", props: { activityState: 2 }, children: [leaf("top")] },
      ],
    });
    expect(out.top).toEqual({ focused: true, depth: 0, known: true });
    expect(out.under).toEqual({ focused: false, depth: 1, known: true });
  });

  it("reads the legacy `active` 0/1 prop when activityState is absent", () => {
    const out = ranks({
      type: "RNSScreenStack",
      children: [
        { type: "RNSScreen", props: { active: 0 }, children: [leaf("under")] },
        { type: "RNSScreen", props: { active: 1 }, children: [leaf("top")] },
      ],
    });
    expect(out.top.focused).toBe(true);
    expect(out.under.focused).toBe(false);
  });

  it("counts stack order through the wrappers react-navigation puts around each route", () => {
    // The screens are never direct siblings in a real tree: each route is wrapped
    // in a scene view first, so the sibling comparison has to climb to the level
    // where the routes sit side by side.
    const route = (state: number, mark: string): NodeSpec => ({
      type: "SceneView",
      children: [{ type: "RNSScreen", props: { activityState: state }, children: [leaf(mark)] }],
    });
    const out = ranks({
      type: "RNSScreenStack",
      children: [route(0, "bottom"), route(1, "middle"), route(2, "top")],
    });
    expect(out.top).toEqual({ focused: true, depth: 0, known: true });
    expect(out.middle).toEqual({ focused: false, depth: 1, known: true });
    expect(out.bottom).toEqual({ focused: false, depth: 2, known: true });
  });

  it("ranks react-navigation JS scenes by their `focused` prop", () => {
    const out = ranks({
      type: "CardStack",
      children: [
        { type: "Card", props: { focused: false }, children: [leaf("under")] },
        { type: "Card", props: { focused: true }, children: [leaf("top")] },
      ],
    });
    expect(out.top).toEqual({ focused: true, depth: 0, known: true });
    expect(out.under).toEqual({ focused: false, depth: 1, known: true });
  });

  it("ranks a pager by its own index against the navigator's", () => {
    const out = ranks({
      type: "Pager",
      children: [
        { type: "Page", props: { index: 0, navigationState: { index: 1 } }, children: [leaf("hidden")] },
        { type: "Page", props: { index: 1, navigationState: { index: 1 } }, children: [leaf("shown")] },
      ],
    });
    expect(out.shown.focused).toBe(true);
    expect(out.hidden.focused).toBe(false);
  });

  it("uses the nearest scene, so a tab inside a focused screen still counts", () => {
    const out = ranks({
      type: "RNSScreenStack",
      children: [
        {
          type: "RNSScreen",
          props: { activityState: 2 },
          children: [
            {
              type: "Pager",
              children: [
                { type: "Page", props: { focused: false }, children: [leaf("otherTab")] },
                { type: "Page", props: { focused: true }, children: [leaf("thisTab")] },
              ],
            },
          ],
        },
      ],
    });
    expect(out.thisTab.focused).toBe(true);
    expect(out.otherTab.focused).toBe(false);
  });

  it("survives a scene prop that throws (Reanimated)", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "activityState", {
      get() {
        throw new Error("[Reanimated] Trying to read an animated value");
      },
      enumerable: true,
    });
    const out = ranks({ type: "RNSScreen", props: hostile, children: [leaf("field")] });
    expect(out.field.focused).toBe(true);
  });

  it("is ES5: the app runtime is Hermes with no transpiler in the path", () => {
    expect(SCENE_RANK).not.toMatch(/=>/);
    expect(SCENE_RANK).not.toMatch(/\b(let|const)\s/);
    expect(SCENE_RANK).not.toMatch(/`/);
  });
});
