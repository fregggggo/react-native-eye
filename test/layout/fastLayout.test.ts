import { describe, it, expect } from "vitest";
import { fastLayoutExpression, viewportExpression } from "../../src/layout/fastLayout.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { fabricFiber, hookGlobals, linkParents, paperFiber, type NodeSpec } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";

function runtimeWithTree(root: any, opts?: { fabric?: boolean }) {
  return makeRuntime(hookGlobals(root, opts));
}

const SCREEN: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } };

async function capture(root: any, fabric: boolean): Promise<any> {
  const runtime = runtimeWithTree(linkParents(root), { fabric });
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(fastLayoutExpression()));
}

describe("fastLayoutExpression", () => {
  it("measures Fabric hosts through nativeFabricUIManager", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTView", props: { onPress: () => {} }, rect: { x: 10, y: 20, w: 100, h: 40 } },
        { type: "RCTText", props: { children: "Login" }, rect: { x: 10, y: 100, w: 80, h: 20 } },
      ],
    });
    const out = await capture(tree, true);
    expect(out.available).toBe(true);
    expect(out.viewport).toEqual({ x: 0, y: 0, w: 400, h: 800 });
    expect(out.els.map((e: any) => e.text ?? e.type)).toEqual(["RCTView", "Login"]);
  });

  it("measures Paper hosts through stateNode.measureInWindow", async () => {
    const tree = paperFiber({
      ...SCREEN,
      children: [{ type: "RCTText", props: { children: "Hi" }, rect: { x: 1, y: 2, w: 30, h: 10 } }],
    });
    const out = await capture(tree, false);
    expect(out.available).toBe(true);
    expect(out.els).toHaveLength(1);
    expect(out.els[0]).toMatchObject({ text: "Hi", x: 1, y: 2, w: 30, h: 10 });
  });

  it("marks scrolled-away rows off-screen instead of presenting them as tappable", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        // A scroll content container taller than the screen — the old code used
        // the largest element as the viewport, so everything inside "fit".
        {
          type: "RCTScrollContentView",
          rect: { x: 0, y: 0, w: 400, h: 3000 },
          children: [
            { type: "RCTText", props: { children: "Visible row" }, rect: { x: 0, y: 100, w: 400, h: 40 } },
            { type: "RCTText", props: { children: "Far below the fold" }, rect: { x: 0, y: 2400, w: 400, h: 40 } },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    const byText = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(out.viewport).toEqual({ x: 0, y: 0, w: 400, h: 800 });
    expect(byText["Visible row"].offscreen).toBeUndefined();
    expect(byText["Far below the fold"].offscreen).toBe(true);
  });

  it("explains why it found nothing instead of reporting an empty screen", async () => {
    const tree = fabricFiber({ type: "RCTView", children: [{ type: "RCTView" }] }); // no measurable nodes
    const out = await capture(tree, true);
    expect(out.available).toBe(false);
    expect(out.error).toMatch(/fibers.*measurable host components/);
  });

  it("reports a missing DevTools hook", async () => {
    const runtime = makeRuntime();
    const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
    const out = JSON.parse(await conn.evaluate(fastLayoutExpression()));
    expect(out.available).toBe(false);
    expect(out.error).toMatch(/DevTools hook not present/);
  });

  it("survives a list long enough to blow a per-sibling recursion", async () => {
    const rows: NodeSpec[] = Array.from({ length: 4000 }, (_, i) => ({
      type: "RCTText",
      props: { children: `row ${i}` },
      rect: { x: 0, y: i * 10, w: 100, h: 10 },
    }));
    const out = await capture(fabricFiber({ ...SCREEN, children: rows }), true);
    expect(out.available).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("caps the number of collected nodes", () => {
    expect(fastLayoutExpression(123)).toContain("123");
  });
});

describe("viewportExpression", () => {
  it("returns the root view frame", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [{ type: "RCTText", props: { children: "x" }, rect: { x: 0, y: 0, w: 10, h: 10 } }],
    });
    const runtime = runtimeWithTree(tree, { fabric: true });
    const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
    expect(JSON.parse(await conn.evaluate(viewportExpression()))).toEqual({ x: 0, y: 0, w: 400, h: 800 });
  });
});

describe("fastLayoutExpression deduplication", () => {
  it("collapses a wrapper and its inner layers around one tap target", async () => {
    // Nested icon/text layers share a centre but not an exact frame.
    const outer = { x: 0, y: 100, w: 200, h: 40 };
    const inner = { x: 10, y: 105, w: 180, h: 30 };
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTText",
          props: { children: "Buy now" },
          rect: outer,
          children: [{ type: "RCTVirtualText", props: { children: "Buy now" }, rect: inner }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(1);
    expect(out.els[0]).toMatchObject({ text: "Buy now", w: 200 }); // the outermost one wins
  });

  // D5: a wrapper and its inner text/icon layer measure a few px apart in
  // practice (padding, rounding), not exactly on top of each other like the
  // synthetic case above. Real observed pair from field testing: outer @101,833
  // vs inner @101,816 — 17px vertical drift on the same "Dismiss" label.
  it("collapses near-duplicate centres (same label, <=17px drift) into one element", async () => {
    const outer = { x: 92, y: 826, w: 18, h: 14 }; // cx=101, cy=833
    const inner = { x: 92, y: 809, w: 18, h: 14 }; // cx=101, cy=816 (dy=17)
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { children: "Dismiss", onPress: () => {} },
          rect: outer,
          children: [{ type: "RCTText", props: { children: "Dismiss" }, rect: inner }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(1);
    expect(out.els[0]).toMatchObject({ text: "Dismiss", x: 92, y: 826 }); // outermost (walked first) wins
  });

  // Tolerance is for labels that repeat because of nesting. Unlabeled controls —
  // a row of small icon buttons with no text and no testID — share the empty
  // label, so a tolerant match there would silently delete real tap targets.
  it("keeps two unlabeled pressables a few pixels apart as two elements", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTView", props: { onPress: () => {} }, rect: { x: 10, y: 100, w: 12, h: 12 } },
        { type: "RCTView", props: { onPress: () => {} }, rect: { x: 24, y: 100, w: 12, h: 12 } },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(2);
  });

  it("keeps two empty inputs with different placeholders apart", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTSinglelineTextInputView", props: { placeholder: "Email" }, rect: { x: 0, y: 100, w: 200, h: 14 } },
        { type: "RCTSinglelineTextInputView", props: { placeholder: "Password" }, rect: { x: 0, y: 110, w: 200, h: 14 } },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(2);
  });

  // Two real "Dismiss" buttons at opposite ends of the screen must both survive:
  // that ambiguity is real and tap({text:"Dismiss"}) needs to see it.
  it("keeps same-label elements that are far apart as two elements", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Dismiss" }, rect: { x: 10, y: 100, w: 60, h: 20 } }, // cx=40,cy=110
        { type: "RCTText", props: { children: "Dismiss" }, rect: { x: 10, y: 700, w: 60, h: 20 } }, // cx=40,cy=710
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(2);
  });

  // Coordinate tolerance must not merge distinct elements just because they
  // happen to sit at the same spot (e.g. overlapping siblings during a transition).
  it("keeps different-label elements at the same centre as two elements", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "A" }, rect: { x: 0, y: 100, w: 40, h: 20 } },
        {
          type: "RCTView",
          props: { testID: "b-marker", onPress: () => {} },
          rect: { x: 0, y: 100, w: 40, h: 20 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(2);
  });
});

describe("visibility of mounted-but-hidden content", () => {
  const screenWith = (props: Record<string, unknown>, label: string): NodeSpec => ({
    type: "RCTView",
    props,
    rect: { x: 0, y: 0, w: 400, h: 800 },
    children: [{ type: "RCTText", props: { children: label }, rect: { x: 0, y: 100, w: 200, h: 40 } }],
  });

  it("hides a subtree behind display:none, opacity:0 and a11y-hidden", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        screenWith({ style: { display: "none" } }, "DisplayNone"),
        screenWith({ style: [{ flex: 1 }, { opacity: 0 }] }, "Transparent"),
        screenWith({ accessibilityElementsHidden: true }, "A11yHidden"),
        screenWith({}, "Shown"),
      ],
    });
    const out = await capture(tree, true);
    const by = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(by["DisplayNone"].hidden).toBe(true);
    expect(by["Transparent"].hidden).toBe(true);
    expect(by["A11yHidden"].hidden).toBe(true);
    expect(by["Shown"].hidden).toBeUndefined();
  });

  it("hides an inactive react-native-screens screen", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [screenWith({ activityState: 0 }, "Background"), screenWith({ activityState: 2 }, "Foreground")],
    });
    const out = await capture(tree, true);
    const by = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(by["Background"].hidden).toBe(true);
    expect(by["Foreground"].hidden).toBeUndefined();
  });

  it("survives a style object that throws when read (Reanimated)", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTText",
          props: {
            children: "Animated",
            get style() {
              throw new Error("[Reanimated] Trying to read an animated style");
            },
          },
          rect: { x: 0, y: 0, w: 100, h: 20 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.available).toBe(true);
    expect(out.els[0].text).toBe("Animated");
  });

  it("hides the pager page that is not the navigator's current index", async () => {
    // Both pages measure identically — only react-navigation's own state says
    // which one the user is looking at.
    const page = (index: number, label: string): NodeSpec => ({
      type: "RCTView",
      props: { index, navigationState: { index: 2 } },
      rect: { x: 0, y: 0, w: 400, h: 800 },
      children: [{ type: "RCTText", props: { children: label }, rect: { x: 0, y: 200, w: 400, h: 40 } }],
    });
    const out = await capture(fabricFiber({ ...SCREEN, children: [page(0, "Feed"), page(2, "Profile")] }), true);
    const by = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(by["Feed"]).toMatchObject({ hidden: true, hiddenBy: "inactive-screen" });
    expect(by["Profile"].hidden).toBeUndefined();
  });

  it("hides a stack scene below the top (focused:false)", async () => {
    const scene = (focused: boolean, label: string): NodeSpec => ({
      type: "RCTView",
      props: { focused },
      rect: { x: 0, y: 0, w: 400, h: 800 },
      children: [{ type: "RCTText", props: { children: label }, rect: { x: 0, y: 100, w: 400, h: 40 } }],
    });
    const out = await capture(fabricFiber({ ...SCREEN, children: [scene(false, "Under"), scene(true, "Top")] }), true);
    const by = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(by["Under"].hidden).toBe(true);
    expect(by["Top"].hidden).toBeUndefined();
  });

  it("leaves ordinary index props alone", async () => {
    // `index` on its own (a list row) must not be mistaken for a scene index.
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Row 3", index: 3 }, rect: { x: 0, y: 10, w: 100, h: 20 } },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els[0].hidden).toBeUndefined();
  });
});

describe("text input collection (D11)", () => {
  it("collects an empty TextInput host that has no testID, press handler or text", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTSinglelineTextInputView",
          props: { placeholder: "Email" },
          rect: { x: 10, y: 200, w: 300, h: 40 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(1);
    expect(out.els[0]).toMatchObject({ type: "RCTSinglelineTextInputView", placeholder: "Email" });
  });

  it("collects an Android empty TextInput host and a multiline variant", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "AndroidTextInput", props: { placeholder: "Search" }, rect: { x: 0, y: 0, w: 100, h: 40 } },
        {
          type: "RCTMultilineTextInputView",
          props: { placeholder: "Notes" },
          rect: { x: 0, y: 50, w: 100, h: 80 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els.map((e: any) => e.type).sort()).toEqual(["AndroidTextInput", "RCTMultilineTextInputView"]);
  });

  it("surfaces the current value alongside the placeholder once typed", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTSinglelineTextInputView",
          props: { placeholder: "Email", value: "cat" },
          rect: { x: 10, y: 200, w: 300, h: 40 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els[0]).toMatchObject({ placeholder: "Email", value: "cat" });
  });

  it("does not collect a plain View just for carrying a value-shaped prop", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [{ type: "RCTView", props: { value: "not an input" }, rect: { x: 0, y: 0, w: 100, h: 40 } }],
    });
    const out = await capture(tree, true);
    expect(out.available).toBe(false); // no testID / press / text / input signal anywhere
  });

  it("collects a custom host carrying onChangeText even without a recognised type name", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTCustomInputHost",
          props: { onChangeText: () => {}, placeholder: "Phone" },
          rect: { x: 0, y: 0, w: 100, h: 40 },
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els).toHaveLength(1);
    expect(out.els[0].placeholder).toBe("Phone");
  });
});

describe("tap point and noise", () => {
  it("clips an element wider than the screen so the tap point stays on it", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Try it free" }, rect: { x: 20, y: 380, w: 10800, h: 26 } },
      ],
    });
    const out = await capture(tree, true);
    const el = out.els[0];
    // Geometric centre would be x≈5420, far off a 400pt-wide screen.
    expect(el.visible).toEqual({ x: 20, y: 380, w: 380, h: 26 });
    expect(el.offscreen).toBeUndefined();
  });

  it("flags an unlabelled icon inside a pressable as decorative", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {} },
          rect: { x: 0, y: 0, w: 100, h: 50 },
          children: [{ type: "RCTView", props: { testID: "icon-heart-fill" }, rect: { x: 10, y: 10, w: 20, h: 20 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els.find((e: any) => e.testID === "icon-heart-fill").decorative).toBe(true);
  });

  it("labels an unlabelled pressable from the icon testID inside it", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {} },
          rect: { x: 40, y: 810, w: 32, h: 32 },
          children: [{ type: "RCTView", props: { testID: "extra-icon-play-square-bold" }, rect: { x: 44, y: 814, w: 24, h: 24 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    const button = out.els.find((e: any) => e.w === 32);
    // Field test D17: the tab bar printed as "? @56,826" five times while the
    // tool already held these testIDs.
    expect(button.labelFrom).toBe("extra-icon-play-square-bold");
  });

  it("does not borrow the icon's testID when the pressable already has its own", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {}, testID: "back-button" },
          rect: { x: 40, y: 810, w: 32, h: 32 },
          children: [{ type: "RCTView", props: { testID: "extra-icon-play-square-bold" }, rect: { x: 44, y: 814, w: 24, h: 24 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    // Its own testID always wins — an agent must never mistake a borrowed
    // label for the button's real identifier.
    const button = out.els.find((e: any) => e.testID === "back-button");
    expect(button.labelFrom).toBeUndefined();
  });

  it("leaves labelFrom unset when a pressable has no identifiable descendant at all", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {} },
          rect: { x: 40, y: 810, w: 32, h: 32 },
          children: [{ type: "RCTView", rect: { x: 44, y: 814, w: 24, h: 24 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    const button = out.els.find((e: any) => e.w === 32);
    // Nothing to borrow — it must degrade honestly (stay "?") rather than
    // invent a label.
    expect(button.labelFrom).toBeUndefined();
    expect(button.testID).toBeUndefined();
    expect(button.text).toBeUndefined();
  });

  it("borrows a testID from a descendant nested more than one level deep", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {} },
          rect: { x: 40, y: 810, w: 32, h: 32 },
          children: [
            {
              // An unlabelled intermediate wrapper (no testID/text/press of its
              // own — a padding/centering View is the common real-world shape)
              // sits between the pressable and the icon.
              type: "RCTView",
              rect: { x: 42, y: 812, w: 28, h: 28 },
              children: [
                { type: "RCTView", props: { testID: "extra-icon-play-square-bold" }, rect: { x: 44, y: 814, w: 24, h: 24 } },
              ],
            },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    const button = out.els.find((e: any) => e.w === 32);
    // descStart/descEnd span the whole subtree, not just direct children, so
    // depth does not matter — only tree order among the labelled descendants does.
    expect(button.labelFrom).toBe("extra-icon-play-square-bold");
  });

  it("borrows from the first testID-bearing icon descendant when there are several", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {} },
          rect: { x: 40, y: 810, w: 32, h: 32 },
          children: [
            { type: "RCTView", props: { testID: "icon-leading" }, rect: { x: 42, y: 814, w: 10, h: 10 } },
            { type: "RCTView", props: { testID: "icon-trailing" }, rect: { x: 58, y: 814, w: 10, h: 10 } },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    const button = out.els.find((e: any) => e.w === 32);
    // The `break` on first match takes the first labelled descendant in tree
    // (render) order — for a leading-icon + trailing-icon button that is the
    // leading icon, matching the button's visual reading order. Documenting
    // this as a choice, not an accident: a caller who wants the trailing icon
    // instead can still reach it directly by its own (non-decorative) testID.
    expect(button.labelFrom).toBe("icon-leading");
  });

  it("flags a container whose label is its children glued together", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { children: [{ props: { children: "Подписки" } }, { props: { children: "Для вас" } }] },
          rect: { x: 0, y: 60, w: 400, h: 48 },
          children: [
            { type: "RCTText", props: { children: "Подписки" }, rect: { x: 0, y: 60, w: 100, h: 48 } },
            { type: "RCTText", props: { children: "Для вас" }, rect: { x: 120, y: 60, w: 100, h: 48 } },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    const glued = out.els.find((e: any) => e.text === "ПодпискиДля вас");
    expect(glued.container).toBe(true);
    expect(out.els.find((e: any) => e.text === "Подписки").container).toBeUndefined();
  });

  it("flags a wrapper that borrowed its only child's text", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          // The wrapper measures wider than the label, so its centre is a
          // different point — the dedupe tolerance cannot and must not catch it.
          type: "RCTView",
          props: { children: { props: { children: "Best and popular" } } },
          rect: { x: 0, y: 120, w: 400, h: 30 },
          children: [{ type: "RCTText", props: { children: "Best and popular" }, rect: { x: 10, y: 120, w: 90, h: 30 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    const wrapper = out.els.find((e: any) => e.type === "RCTView");
    const leaf = out.els.find((e: any) => e.type === "RCTText");
    expect(wrapper.container).toBe(true);
    expect(leaf.container).toBeUndefined();
  });

  it("does not call a text host a container just because it nests virtual text", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTText",
          props: { children: "Hello" },
          rect: { x: 0, y: 10, w: 100, h: 20 },
          children: [{ type: "RCTVirtualText", props: { children: "Hello" }, rect: { x: 0, y: 10, w: 100, h: 20 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.els.find((e: any) => e.type === "RCTText").container).toBeUndefined();
  });

  // The relaxed one-leaf container rule (D16) makes more wrappers count as
  // containers; the pre-existing `!h.press` guard must keep excluding the
  // common legitimate case — a button whose own label happens to match its
  // single Text child — or a real tappable target would get demoted and
  // findByText would prefer its non-interactive label instead.
  it("does not demote a pressable wrapper's own label to a container", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => {}, children: { props: { children: "Save" } } },
          rect: { x: 0, y: 120, w: 400, h: 40 },
          children: [{ type: "RCTText", props: { children: "Save" }, rect: { x: 10, y: 120, w: 60, h: 40 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    const wrapper = out.els.find((e: any) => e.type === "RCTView");
    expect(wrapper.container).toBeUndefined();
  });

  // A chain of nested single-child wrappers (a common real layout: a
  // touchable inside a row inside a card) must not chain-flag its way down
  // to the leaf, and must not leave more than one non-container element
  // fighting over the same label.
  it("flags each container in a nested chain without leaving duplicate real elements", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { children: { props: { children: { props: { children: "Save" } } } } },
          rect: { x: 0, y: 120, w: 400, h: 60 },
          children: [
            {
              type: "RCTView",
              props: { children: { props: { children: "Save" } } },
              rect: { x: 20, y: 120, w: 200, h: 40 },
              children: [{ type: "RCTText", props: { children: "Save" }, rect: { x: 40, y: 120, w: 80, h: 40 } }],
            },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    const views = out.els.filter((e: any) => e.type === "RCTView");
    const leaf = out.els.find((e: any) => e.type === "RCTText");
    expect(views).toHaveLength(2);
    expect(views.every((e: any) => e.container === true)).toBe(true);
    expect(leaf.container).toBeUndefined();
  });
});

describe("LogBox overlay coverage (D12)", () => {
  it("marks the screen as covered when a full-screen LogBox redbox is up", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Georgy" }, rect: { x: 0, y: 200, w: 200, h: 40 } },
        {
          // LogBox renders its inspector over everything; the field test tapped
          // straight through it (D12).
          type: "LogBoxInspectorContainer",
          children: [
            { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } },
            { type: "RCTText", props: { children: "Dismiss", onPress: () => {} }, rect: { x: 10, y: 700, w: 80, h: 30 } },
          ],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.overlay).toBe(true);
    const byText = Object.fromEntries(out.els.map((e: any) => [e.text, e]));
    expect(byText["Georgy"].hidden).toBe(true);
    expect(byText["Georgy"].hiddenBy).toBe("covered");
    // The only way out of a redbox is its own button: it must stay tappable.
    expect(byText["Dismiss"].hidden).toBeUndefined();
  });

  it("leaves the screen alone for a small LogBox toast", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Georgy" }, rect: { x: 0, y: 200, w: 200, h: 40 } },
        {
          type: "LogBoxNotificationContainer",
          children: [{ type: "RCTView", rect: { x: 0, y: 760, w: 400, h: 40 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.overlay).toBeFalsy();
    expect(out.els.find((e: any) => e.text === "Georgy").hidden).toBeUndefined();
  });

  // The 60% coverage constant is load-bearing: it is the only thing separating
  // a redbox from a toast. Pin both sides of it so a later refactor cannot
  // silently drift the threshold. Viewport is 400x800 (area 320000); 60% of
  // that is 192000, i.e. height 480 at full width. 470 (58.75%) sits just
  // under; 490 (61.25%) sits just over.
  it("does not blank the screen for an overlay just under the 60% coverage threshold", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Georgy" }, rect: { x: 0, y: 600, w: 200, h: 40 } },
        {
          type: "LogBoxInspectorContainer",
          children: [{ type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 470 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.overlay).toBeFalsy();
    expect(out.els.find((e: any) => e.text === "Georgy").hidden).toBeUndefined();
  });

  it("blanks the screen for an overlay just over the 60% coverage threshold", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "Georgy" }, rect: { x: 0, y: 600, w: 200, h: 40 } },
        {
          type: "LogBoxInspectorContainer",
          children: [{ type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 490 } }],
        },
      ],
    });
    const out = await capture(tree, true);
    expect(out.overlay).toBe(true);
    const georgy = out.els.find((e: any) => e.text === "Georgy");
    expect(georgy.hidden).toBe(true);
    expect(georgy.hiddenBy).toBe("covered");
  });

  // Plan-mandated safe() guard: isLogBox runs on every fiber, host and
  // composite alike, so a composite whose `type` object has a throwing
  // displayName getter must not abort the whole capture the way an
  // unguarded read would (fastLayout.ts:151-157 wraps the walk in a try, but
  // that try aborts the ENTIRE capture rather than just this node).
  it("keeps capturing when a fiber's type has a throwing displayName getter", async () => {
    const ThrowingType: any = function ThrowingType() {};
    Object.defineProperty(ThrowingType, "displayName", {
      get() {
        throw new Error("Reanimated-style throwing getter on a component type");
      },
    });
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: ThrowingType,
          children: [{ type: "RCTText", props: { children: "Georgy" }, rect: { x: 0, y: 200, w: 200, h: 40 } }],
        } as any,
      ],
    });
    const out = await capture(tree, true);
    expect(out.available).toBe(true);
    expect(out.els.find((e: any) => e.text === "Georgy")).toBeTruthy();
  });
});

describe("LogBox surface left mounted after dismiss (D25)", () => {
  const surface = (containerProps: Record<string, unknown> | undefined, withRoot = true) => {
    const container: any = {
      type: "_LogBoxInspectorContainer",
      props: containerProps,
      children: [
        { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } },
        { type: "RCTText", props: { children: "Dismiss", onPress: () => {} }, rect: { x: 10, y: 700, w: 80, h: 30 } },
      ],
    };
    return fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { children: "For You" }, rect: { x: 0, y: 200, w: 200, h: 40 } },
        withRoot ? { type: "LogBox(RootComponent)", children: [container] } : container,
      ],
    });
  };

  it("is not an overlay when the inspector has no logs and nothing selected", async () => {
    const out = await capture(surface({ logs: [], selectedLogIndex: -1 }), true);
    expect(out.overlay).toBeFalsy();
    expect(out.els.find((e: any) => e.text === "For You").hidden).toBeUndefined();
  });

  it("is not an overlay when logs is a zero count", async () => {
    const out = await capture(surface({ logs: 0, selectedLogIndex: -1 }, false), true);
    expect(out.overlay).toBeFalsy();
  });

  it("is not an overlay when no log is selected even if logs exist (minimized)", async () => {
    const out = await capture(surface({ logs: [{}], selectedLogIndex: -1 }), true);
    expect(out.overlay).toBeFalsy();
  });

  it("is still an overlay when the inspector shows a selected log", async () => {
    const out = await capture(surface({ logs: [{}], selectedLogIndex: 0 }), true);
    expect(out.overlay).toBe(true);
    expect(out.els.find((e: any) => e.text === "For You").hiddenBy).toBe("covered");
  });

  it("stays conservative (overlay) when the props are unreadable", async () => {
    const out = await capture(surface(undefined), true);
    expect(out.overlay).toBe(true);
  });
});

// D37. Measured on demo-app's Trends list (LegendList 2.0.19, RN 0.83 Fabric,
// viewport 411x826 dp): a recycled container is parked with
// transform:[{translateY:-10000000}] (the library's POSITION_OUT_OF_VIEW = -1e7)
// and still holds the row it last rendered, so measureInWindow reports a whole
// stale card ~1e7 dp above the window — `Jul 6, 2026 @680,-35002304` in px.
describe("parked / absurd frames (D37)", () => {
  const VIEW: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 411, h: 826 } };
  const list = (rows: NodeSpec[]): any =>
    fabricFiber({
      ...VIEW,
      children: [
        {
          type: "RCTScrollView",
          rect: { x: 0, y: -41, w: 411, h: 891 },
          children: [{ type: "RCTView", rect: { x: 0, y: -1396, w: 411, h: 8914 }, children: rows }],
        },
      ],
    });
  const labels = (out: any) => out.els.map((e: any) => e.text);

  it("drops the stale row inside a list container parked ten million dp away", async () => {
    const out = await capture(
      list([
        { type: "RCTText", props: { children: "Jul 21, 2026" }, rect: { x: 121, y: 181, w: 69, h: 21 } },
        { type: "RCTText", props: { children: "Jul 6, 2026" }, rect: { x: 134, y: 1073, w: 62, h: 21 } },
        {
          type: "RCTView",
          props: { style: [{ position: "absolute", top: 0 }, { transform: [{ translateY: -10000000 }] }] },
          rect: { x: 0, y: -10001396, w: 411, h: 892 },
          children: [
            { type: "RCTText", props: { children: "@dontpanicontitanic" }, rect: { x: 60, y: -10000710, w: 140, h: 21 } },
            { type: "RCTText", props: { children: "Jul 6, 2026" }, rect: { x: 163, y: -10000710, w: 62, h: 21 } },
          ],
        },
      ]),
      true,
    );
    expect(labels(out)).toEqual(["Jul 21, 2026", "Jul 6, 2026"]);
    // The real off-screen row is still there, and still marked as such.
    expect(out.els[1]).toMatchObject({ text: "Jul 6, 2026", y: 1073, offscreen: true });
  });

  it("drops a frame parked far to the side or far below as well", async () => {
    const out = await capture(
      list([
        { type: "RCTText", props: { children: "Real" }, rect: { x: 10, y: 100, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Parked below" }, rect: { x: 0, y: 10000304, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Parked right" }, rect: { x: 5000000, y: 100, w: 60, h: 20 } },
      ]),
      true,
    );
    expect(labels(out)).toEqual(["Real"]);
  });

  it("drops a frame whose coordinates are not finite numbers", async () => {
    const out = await capture(
      list([
        { type: "RCTText", props: { children: "Real" }, rect: { x: 10, y: 100, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "NaN y" }, rect: { x: 10, y: NaN, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Infinite x" }, rect: { x: -Infinity, y: 100, w: 60, h: 20 } },
      ]),
      true,
    );
    expect(labels(out)).toEqual(["Real"]);
    expect(JSON.stringify(out)).not.toMatch(/null,"w"|"x":null|"y":null/);
  });

  // The bound is "a million units past the viewport edge": far beyond what any
  // mounted scroll content reaches (≈1200 screens), far short of the parking
  // constants seen in the field (±1e7). Pin both sides.
  it("keeps a row of a very long mounted list that is merely far off-screen", async () => {
    const out = await capture(
      list([
        { type: "RCTText", props: { children: "Real" }, rect: { x: 10, y: 100, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Row 9000" }, rect: { x: 10, y: 900000, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Row -9000" }, rect: { x: 10, y: -900000, w: 60, h: 20 } },
        { type: "RCTText", props: { children: "Just past" }, rect: { x: 10, y: 1000900, w: 60, h: 20 } },
      ]),
      true,
    );
    expect(labels(out)).toEqual(["Real", "Row 9000", "Row -9000"]);
    expect(out.els[1].offscreen).toBe(true);
  });

  it("does not let a parked LogBox-free ghost decide availability: an all-parked tree reports why", async () => {
    const out = await capture(
      list([{ type: "RCTText", props: { children: "Ghost" }, rect: { x: 0, y: -10000710, w: 60, h: 20 } }]),
      true,
    );
    expect(out.available).toBe(false);
    expect(out.error).toMatch(/none had a (usable|non-zero) frame/);
  });
});

// D34 / D38. Shapes measured on demo-app (RN 0.83.1 Fabric, emulator-5554,
// dp): the app root is 411.4x891.4 at y=-41.1; LogBox's toast lives in the app
// root under _LogBoxNotificationContainer, its pressable row at
// [10, 753.7, 391.4, 48] — right over the tab bar, whose cells are
// [28+75n, 767.1, 56, 38.3] with a 24x24 icon inside. The toast's message is a
// zero-sized RCTVirtualText four composites below the row, so the row had no
// label at all (`? @720,2866`).
const APP_ROOT: NodeSpec = { type: "RCTView", rect: { x: 0, y: -41.1, w: 411.4, h: 891.4 } };

function toastTree(o?: { level?: string; content?: string; containerProps?: Record<string, unknown>; noLog?: boolean }): NodeSpec {
  const log = { level: o?.level ?? "fatal", message: { content: o?.content ?? "rne-d38" } };
  return {
    type: "LogBoxStateSubscription",
    children: [
      {
        type: "_LogBoxNotificationContainer",
        props: o?.containerProps ?? { logs: [log], selectedLogIndex: -1 },
        children: [
          {
            type: "RCTSafeAreaView",
            rect: { x: 10, y: 711.7, w: 391.4, h: 118.6 },
            children: [
              {
                type: "LogBoxNotification",
                props: o?.noLog ? {} : { log, totalLogCount: 1, level: "error" },
                children: [
                  {
                    type: "RCTView",
                    rect: { x: 10, y: 753.4, w: 391.4, h: 48 },
                    children: [
                      {
                        type: "RCTView", // LogBoxButton's host: the row, opens the inspector
                        props: { onClick: () => {} },
                        rect: { x: 10, y: 753.7, w: 391.4, h: 48 },
                        children: [
                          {
                            type: "LogBoxNotificationCountBadge",
                            children: [{ type: "RCTText", props: { children: "!" }, rect: { x: 28, y: 768.9, w: 10, h: 18 } }],
                          },
                          {
                            type: "LogBoxNotificationMessage",
                            children: [
                              {
                                type: "RCTText",
                                rect: { x: 60.9, y: 766.9, w: 303.4, h: 22 },
                                children: [
                                  { type: "RCTVirtualText", props: { children: log.message.content }, rect: { x: 0, y: 0, w: 0, h: 0 } },
                                ],
                              },
                            ],
                          },
                          {
                            type: "LogBoxNotificationDismissButton",
                            children: [
                              {
                                type: "RCTView",
                                props: { onClick: () => {} },
                                rect: { x: 369.4, y: 768, w: 20, h: 20 },
                                children: [{ type: "RCTImageView", rect: { x: 375.4, y: 774, w: 8, h: 8 } }],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const TAB_CELL = (x: number, id: string): NodeSpec => ({
  type: "RCTView",
  props: { onClick: () => {}, accessibilityRole: "button" },
  rect: { x, y: 767.1, w: 56, h: 38.3 },
  children: [{ type: "RCTView", props: { testID: id }, rect: { x: x + 16, y: 774.3, w: 24, h: 24 } }],
});

const APP_CONTENT: NodeSpec[] = [
  { type: "RCTText", props: { children: "For You" }, rect: { x: 130.9, y: 10.9, w: 71.4, h: 21.1 } },
  // Overlaps the toast's top edge, tap point above it: still reachable.
  { type: "RCTText", props: { children: "Georgy", onPress: () => {} }, rect: { x: 20, y: 700, w: 200, h: 60 } },
  TAB_CELL(28, "extra-icon-play-square-bold"),
  TAB_CELL(102.9, "phosphor-react-native-magnifying-glass-regular"),
];

describe("LogBox toast (D34)", () => {
  const find = (out: any, pred: (e: any) => boolean) => out.els.find(pred);

  it("lists the toast under its message and its close button under a name", async () => {
    const out = await capture(fabricFiber({ ...APP_ROOT, children: [...APP_CONTENT, toastTree()] }), true);
    const row = find(out, (e) => e.text === "LogBox fatal: rne-d38");
    expect(row).toMatchObject({ x: 10, y: 753.7, w: 391.4, h: 48 });
    expect(row.hidden).toBeUndefined();
    const close = find(out, (e) => e.text === "Dismiss LogBox toast");
    expect(close).toMatchObject({ x: 369.4, y: 768, w: 20, h: 20 });
    expect(close.hidden).toBeUndefined();
    // Nothing is left as an anonymous "?" pressable in the toast.
    expect(out.els.filter((e: any) => !e.text && !e.testID && !e.labelFrom)).toEqual([]);
  });

  it("marks what sits under the toast as covered, by tap point", async () => {
    const out = await capture(fabricFiber({ ...APP_ROOT, children: [...APP_CONTENT, toastTree()] }), true);
    const icon = find(out, (e) => e.testID === "phosphor-react-native-magnifying-glass-regular");
    expect(icon).toMatchObject({ hidden: true, hiddenBy: "covered" });
    // The cell is taller than the toast (ends at 805.4 vs 801.7) but its centre is under it.
    const cell = find(out, (e) => e.labelFrom === "extra-icon-play-square-bold");
    expect(cell).toMatchObject({ hidden: true, hiddenBy: "covered" });
    expect(find(out, (e) => e.text === "For You").hidden).toBeUndefined();
    expect(find(out, (e) => e.text === "Georgy").hidden).toBeUndefined();
    // The toast's own badge is part of it, not under it.
    expect(find(out, (e) => e.text === "!").hidden).toBeUndefined();
    expect(out.overlay).toBeFalsy();
  });

  it("reports the toast so the tool can say where it is and how much it hides", async () => {
    const out = await capture(fabricFiber({ ...APP_ROOT, children: [...APP_CONTENT, toastTree()] }), true);
    expect(out.toasts).toEqual([{ x: 10, y: 753.7, w: 391.4, h: 48, text: "LogBox fatal: rne-d38", covers: 4 }]);
  });

  it("reports no toast when there is none", async () => {
    const out = await capture(fabricFiber({ ...APP_ROOT, children: APP_CONTENT }), true);
    expect(out.toasts).toBeUndefined();
    expect(out.els.every((e: any) => !e.hidden)).toBe(true);
  });

  it("names the level and shortens a long message", async () => {
    const long = "Warning: " + "x".repeat(300);
    const out = await capture(
      fabricFiber({ ...APP_ROOT, children: [...APP_CONTENT, toastTree({ level: "warn", content: long })] }),
      true,
    );
    const row = find(out, (e) => typeof e.text === "string" && e.text.indexOf("LogBox warn: Warning: xxx") === 0);
    expect(row).toBeTruthy();
    expect(row.text.length).toBeLessThanOrEqual(100);
    expect(row.text.endsWith("…")).toBe(true);
  });

  it("keeps the message's own letters and folds its line breaks", async () => {
    const out = await capture(
      fabricFiber({
        ...APP_ROOT,
        children: [...APP_CONTENT, toastTree({ level: "error", content: "Missing keys\n  in  lists\tand sections" })],
      }),
      true,
    );
    expect(find(out, (e) => e.text === "LogBox error: Missing keys in lists and sections")).toBeTruthy();
  });

  it("still names the toast when its log prop cannot be read", async () => {
    const out = await capture(fabricFiber({ ...APP_ROOT, children: [...APP_CONTENT, toastTree({ noLog: true })] }), true);
    expect(find(out, (e) => e.text === "LogBox toast")).toBeTruthy();
    expect(find(out, (e) => e.text === "Dismiss LogBox toast")).toBeTruthy();
  });

  it("does not treat off-screen or already hidden elements as newly covered", async () => {
    const out = await capture(
      fabricFiber({
        ...APP_ROOT,
        children: [
          {
            type: "RCTView",
            props: { activityState: 0 },
            children: [{ type: "RCTText", props: { children: "Other tab" }, rect: { x: 100, y: 770, w: 80, h: 20 } }],
          },
          toastTree(),
        ],
      }),
      true,
    );
    expect(find(out, (e) => e.text === "Other tab")).toMatchObject({ hidden: true, hiddenBy: "inactive-screen" });
    expect(out.toasts[0].covers).toBe(0);
  });
});

// D38: the inspector's surface is a second fiber root, full-size and measurable
// whether or not its dialog window was ever shown — identical frames in both
// states, so the expression cannot settle it. It keeps its own verdict and
// hands the tool what it needs to withdraw it: which elements are the
// inspector's (`overlay`), and what each covered element was before
// (`beneath`).
describe("LogBox overlay verdict is reversible (D38)", () => {
  const inspector = (sel: number): NodeSpec => ({
    type: "LogBox(RootComponent)",
    children: [
      {
        type: "_LogBoxInspectorContainer",
        props: { logs: [{}], selectedLogIndex: sel },
        children: [
          { type: "RCTView", rect: { x: 0, y: 0, w: 411.4, h: 826.3 } },
          { type: "RCTText", props: { children: "Dismiss", onPress: () => {} }, rect: { x: 0, y: 778.3, w: 205.7, h: 48 } },
        ],
      },
    ],
  });
  const tree = (sel: number, toast = true) =>
    fabricFiber({
      ...APP_ROOT,
      children: [
        ...APP_CONTENT,
        {
          type: "RCTView",
          props: { activityState: 0 },
          children: [{ type: "RCTText", props: { children: "Other tab" }, rect: { x: 100, y: 300, w: 80, h: 20 } }],
        },
        ...(toast ? [toastTree({ containerProps: { logs: [{}], selectedLogIndex: sel } })] : []),
        inspector(sel),
      ],
    });
  const byText = (out: any) => Object.fromEntries(out.els.filter((e: any) => e.text).map((e: any) => [e.text, e]));

  it("tags the inspector's own elements and remembers what each covered element was", async () => {
    const out = await capture(tree(0), true);
    expect(out.overlay).toBe(true);
    const t = byText(out);
    expect(t["Dismiss"]).toMatchObject({ overlay: true });
    expect(t["Dismiss"].hidden).toBeUndefined();
    expect(t["For You"]).toMatchObject({ hidden: true, hiddenBy: "covered", beneath: "visible" });
    expect(t["Other tab"]).toMatchObject({ hidden: true, hiddenBy: "covered", beneath: "inactive-screen" });
    // Under the toast before the redbox came up: still covered once the redbox verdict is withdrawn.
    const icon = out.els.find((e: any) => e.testID === "phosphor-react-native-magnifying-glass-regular");
    expect(icon).toMatchObject({ hidden: true, hiddenBy: "covered", beneath: "covered" });
  });

  it("a real redbox covers the toast too: the toast is an app element, not part of the overlay", async () => {
    const out = await capture(tree(0), true);
    const t = byText(out);
    expect(t["LogBox fatal: rne-d38"]).toMatchObject({ hidden: true, hiddenBy: "covered", beneath: "visible" });
    expect(t["LogBox fatal: rne-d38"].overlay).toBeUndefined();
    expect(t["Dismiss LogBox toast"]).toMatchObject({ hidden: true, hiddenBy: "covered", beneath: "visible" });
  });

  it("adds neither field when nothing covers the screen", async () => {
    const out = await capture(tree(-1), true);
    expect(out.overlay).toBeFalsy();
    expect(out.els.some((e: any) => e.overlay !== undefined || e.beneath !== undefined)).toBe(false);
  });

  it("a toast alone never makes an overlay, whatever selectedLogIndex says", async () => {
    const out = await capture(
      fabricFiber({
        ...APP_ROOT,
        children: [...APP_CONTENT, toastTree({ containerProps: { logs: [{}], selectedLogIndex: 0 } })],
      }),
      true,
    );
    expect(out.overlay).toBeFalsy();
    expect(byText(out)["For You"].hidden).toBeUndefined();
  });
});
