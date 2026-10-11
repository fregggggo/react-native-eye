import { describe, it, expect } from "vitest";
import { fastLayoutExpression } from "../../src/layout/fastLayout.js";
import { parseAxe } from "../../src/layout/parseAxe.js";
import { toElements, formatLayout } from "../../src/layout/elements.js";
import { searchElements } from "../../src/layout/search.js";
import { listInputsExpression } from "../../src/input/text.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { fiberTreeFixture, readFixture, type FiberFixture, type FixtureNode } from "../helpers/loadFixture.js";
import { Connection } from "../../src/core/registry.js";

// A hand-built tree only contains shapes someone thought to write down. These
// run the same walkers against a tree an app actually produced — the 20-deep
// opacity:0 ancestor of D4, the 2px coordinate splits of D5, the four-level
// TextInput wrapper chain, the phosphor-* testID noise of D8.
function runtimeFor(root: any) {
  return makeRuntime({
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: root }]),
    },
    nativeFabricUIManager: {
      measureInWindow: (node: any, cb: (x: number, y: number, w: number, h: number) => void) =>
        cb(node.__rect.x, node.__rect.y, node.__rect.w, node.__rect.h),
    },
  });
}

function connFor(root: any): Connection {
  return new Connection(fakeClient(runtimeFor(root)) as any, { port: 0, targetId: "t", title: "fixture" });
}

async function fixtureLayout(): Promise<any> {
  const conn = connFor(fiberTreeFixture("fiber-tree.json"));
  return JSON.parse(await conn.evaluate(fastLayoutExpression(4000)));
}

function descendantsOf(fixture: FiberFixture, root: number): FixtureNode[] {
  const kids = new Map<number, number[]>();
  for (const n of fixture.nodes) {
    if (n.parent < 0) continue;
    const list = kids.get(n.parent);
    if (list) list.push(n.i);
    else kids.set(n.parent, [n.i]);
  }
  const out: FixtureNode[] = [];
  const stack = [root];
  while (stack.length) {
    for (const i of kids.get(stack.pop()!) ?? []) {
      out.push(fixture.nodes[i]);
      stack.push(i);
    }
  }
  return out;
}

describe("recorded fiber tree", () => {
  it("walks without throwing and yields elements", async () => {
    const out = await fixtureLayout();
    expect(out.error).toBeUndefined();
    expect(out.available).toBe(true);
    expect(out.els.length).toBeGreaterThan(0);
    expect(out.viewport).toBeTruthy();
  });

  it("carries the shapes nobody hand-builds", () => {
    // Proof the fixture is worth having. Each of these was recorded, not
    // invented, and each is a shape a test author would not have thought to
    // write: they are the exact shapes the field test found defects in.
    const fixture = readFixture<FiberFixture>("fiber-tree.json");
    const nodes = fixture.nodes;

    // D4's shape: an ancestor declaring opacity 0 in its props while Reanimated
    // animates the real opacity on the UI thread, so the prop stays 0 forever.
    expect(nodes.filter((n) => n.props.styleOpacity === 0).length).toBeGreaterThan(0);

    // react-native-screens keeps blurred tabs mounted with activityState 0.
    // A hand-built tree has one screen; this app has several, most of them inactive.
    const states = nodes.map((n) => n.props.activityState).filter((s) => s !== undefined);
    expect(states).toContain(0);
    expect(states).toContain(2);

    // The testID distribution that made `tap({testID})` useless on a real app:
    // every testID present comes from an icon library, none from the app itself.
    const testIDs = nodes.map((n) => n.props.testID).filter((t): t is string => !!t);
    expect(testIDs.length).toBeGreaterThan(0);
    expect(testIDs.every((t) => /^(phosphor|extra)-/.test(t))).toBe(true);

    // One search field on screen, but several fibers carrying onChangeText —
    // the NativeWind/CssInterop wrapper chain that dedupe has to collapse.
    expect(nodes.filter((n) => n.props.onChangeText).length).toBeGreaterThan(1);
  });

  // Not skipped because the assertion is wrong — skipped because THIS recording
  // does not contain the shape. The screen captured had no Reanimated style
  // object that throws on property access; it had the declared-opacity-0 shape
  // instead (asserted live above). The capture script does detect throwing
  // styles (`styleThrows`, scripts/capture-fixtures.ts:68,100), so a recording
  // taken while an animation is mid-flight will populate it, and this test
  // un-skips by deleting `.skip`. Left in full rather than deleted so the gap
  // stays visible instead of being quietly forgotten.
  it.skip("carries a style that throws on read, and the walk still completes", async () => {
    const fixture = readFixture<FiberFixture>("fiber-tree.json");
    const throwing = fixture.nodes.filter((n) => n.props.styleThrows === true);
    expect(throwing.length).toBeGreaterThan(0);

    const root = fiberTreeFixture("fiber-tree.json");
    let seen = 0;
    const check = (f: any): void => {
      if (!f) return;
      const st = f.memoizedProps?.style;
      const members = Array.isArray(st) ? st : st ? [st] : [];
      for (const m of members) {
        try {
          void (m as any).opacity;
        } catch {
          seen++;
        }
      }
      check(f.child);
      check(f.sibling);
    };
    check(root);
    expect(seen).toBeGreaterThan(0);

    const out = await fixtureLayout();
    expect(out.available).toBe(true);
  });
});

describe("recorded describe-ui payload", () => {
  it("parses into a stable element list", () => {
    const fixture = readFixture<{ meta: Record<string, unknown>; tree: unknown }>("describe-ui.json");
    const els = parseAxe(JSON.stringify(fixture.tree));
    expect(els.length).toBeGreaterThan(0);
    expect(els.length).toMatchSnapshot("element count");
    expect(
      els.slice(0, 5).map((e) => ({
        text: e.text,
        testID: e.testID,
        type: e.type,
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        offscreen: e.offscreen,
      })),
    ).toMatchSnapshot("first five elements");
  });
});

describe("recorded text inputs", () => {
  it("reports a wrapper chain as one input, not one per level", async () => {
    // The live app's search field is CssInterop.TextInput -> TextInput ->
    // InternalTextInput -> RCTSinglelineTextInputView, all four carrying the
    // same placeholder and the same onChangeText. Only the last one is a host.
    const fixture = readFixture<FiberFixture>("fiber-tree.json");
    const carriers = fixture.nodes.filter((n) => n.props.onChangeText || n.props.placeholder !== undefined);
    expect(carriers.length).toBeGreaterThan(0);

    const conn = connFor(fiberTreeFixture("fiber-tree.json"));
    const { inputs } = JSON.parse(await conn.evaluate(listInputsExpression()));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.length).toBeLessThanOrEqual(carriers.length);

    const counts = new Map<string, number>();
    for (const i of inputs) {
      const k = `${i.placeholder ?? ""}|${i.testID ?? ""}|${Math.round(i.x)},${Math.round(i.y)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect([...counts.entries()].filter(([, c]) => c > 1)).toEqual([]);
  });
});

describe("regressions owned by spec B", () => {
  // spec B: D4 — styleHides trusts the declared style.opacity. Reanimated
  // animates opacity on the UI thread, so the fiber prop stays 0 forever and a
  // whole visible subtree is reported hidden. In the field test the ancestor was
  // twenty levels above the element it buried.
  it.skip("keeps a subtree visible when an ancestor still declares opacity:0", async () => {
    const fixture = readFixture<FiberFixture>("fiber-tree.json");
    const viewport = fixture.nodes.reduce(
      (best, n) => (n.rect && n.rect.w * n.rect.h > best.w * best.h ? n.rect : best),
      { x: 0, y: 0, w: 0, h: 0 },
    );
    const onScreen = (r: { x: number; y: number; w: number; h: number }) =>
      r.w > 0 && r.h > 0 && r.x < viewport.x + viewport.w && r.y < viewport.y + viewport.h && r.x + r.w > viewport.x && r.y + r.h > viewport.y;

    const faded = fixture.nodes.find(
      (n) => n.props.styleOpacity === 0 && descendantsOf(fixture, n.i).some((d) => d.props.childrenText && d.rect && onScreen(d.rect)),
    );
    expect(faded).toBeTruthy();

    const buried = descendantsOf(fixture, faded!.i).filter((d) => d.props.childrenText && d.rect && onScreen(d.rect));
    const out = await fixtureLayout();
    const shown = new Set(out.els.filter((e: any) => !e.hidden && !e.offscreen).map((e: any) => e.text));
    expect(buried.map((d) => d.props.childrenText).filter((t) => !shown.has(t))).toEqual([]);
  });

  // spec B: D5 — the dedupe key is `text|testID|cx,cy` with exact coordinates, so
  // a wrapper and its text leaf 2-17px apart both survive; tap({text:"Dismiss"})
  // then refuses with "Ambiguous text — 2 visible elements match" for what the
  // user sees as one control.
  it.skip("collapses two entries whose centres are within 4px", async () => {
    const out = await fixtureLayout();
    const els = toElements(out.els).filter((e) => e.text);
    const dupes: string[] = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        if (els[i].text !== els[j].text) continue;
        if (Math.abs(els[i].cx - els[j].cx) < 4 && Math.abs(els[i].cy - els[j].cy) < 4) {
          dupes.push(`${els[i].text} @${els[i].cx},${els[i].cy} / @${els[j].cx},${els[j].cy}`);
        }
      }
    }
    expect(dupes).toEqual([]);
  });

  // spec B: D8 — formatLayout suppresses decorative elements even when the caller
  // asked for them by name. get_layout({search:["phosphor"]}) answered with
  // "(+14 decorative/container elements — searchable and tappable, not listed)"
  // and nothing else, so the only way to learn a testID was to bypass the tool.
  it.skip("lists a decorative icon that was searched for explicitly", async () => {
    const out = await fixtureLayout();
    const els = toElements(out.els);
    const icons = els.filter((e) => (e.testID ?? "").startsWith("phosphor"));
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.some((e) => e.decorative)).toBe(true);

    const listing = formatLayout(searchElements(els, { search: ["phosphor"] }));
    expect(listing).toContain(icons[0].testID!);
    expect(listing).not.toMatch(/^\(\+\d+ decorative/m);
  });
});
