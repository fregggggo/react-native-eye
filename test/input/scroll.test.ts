import { describe, it, expect } from "vitest";
import {
  scrollToExpression,
  scrollByExpression,
  type ScrollResult,
  type ScrollByResult,
} from "../../src/input/scroll.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { linkParents, fabricFiber, hookGlobals, type NodeSpec } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";

/**
 * A composite (non-host) fiber. `fabricFiber` builds host nodes only, and the
 * scroll API never lives on a host: ScrollView and FlatList are class
 * components whose instance *is* the fiber's stateNode.
 */
function composite(name: string, instance: any, child: any, props: Record<string, unknown> = {}): any {
  const type: any = function () {};
  type.displayName = name;
  return { type, memoizedProps: props, stateNode: instance, child, sibling: null };
}

/** Root view, unmeasured, with one child — then every `return` pointer linked. */
function screen(child: any): any {
  return linkParents({ type: "RCTView", memoizedProps: {}, stateNode: null, child, sibling: null });
}

async function scrollTo(root: any, x: number, y: number): Promise<ScrollResult> {
  const runtime = makeRuntime(hookGlobals(root, { fabric: true }));
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(scrollToExpression(x, y)));
}

/**
 * A scroll view at y=100, 600 tall, already scrolled 500pt down — the content
 * view's top edge sits 500pt above the scroll view's. Row 42 is at y=900, far
 * below the fold, which is exactly the case `tap` refuses.
 */
const LIST_HOSTS: NodeSpec = {
  type: "RCTScrollView",
  rect: { x: 0, y: 100, w: 400, h: 600 },
  children: [
    {
      type: "RCTScrollContentView",
      rect: { x: 0, y: -400, w: 400, h: 3000 },
      children: [{ type: "RCTText", props: { children: "Row 42" }, rect: { x: 0, y: 900, w: 400, h: 40 } }],
    },
  ],
};

describe("scrollToExpression", () => {
  it("scrolls a FlatList ancestor through scrollToOffset", async () => {
    const calls: any[] = [];
    const root = screen(
      composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(LIST_HOSTS)),
    );
    const out = await scrollTo(root, 200, 920);
    expect(out).toEqual({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    // 500 already scrolled + 800 from the container's top edge - a quarter of
    // the 600pt viewport, so the row lands below the top edge, not under it.
    expect(calls).toHaveLength(1);
    expect(calls[0].offset).toBe(1150);
    expect(calls[0].animated).toBe(false);
  });

  it("scrolls a ScrollView ancestor through scrollTo", async () => {
    // The host RCTScrollView is climbed past on the way: its name is in the
    // adapter table but a native host instance has no scrollTo, so the climb
    // continues to the composite that does.
    const calls: any[] = [];
    const hosts: NodeSpec = {
      type: "RCTScrollView",
      rect: { x: 0, y: 0, w: 400, h: 800 },
      children: [
        {
          type: "RCTScrollContentView",
          rect: { x: 0, y: 0, w: 400, h: 2000 },
          children: [{ type: "RCTText", props: { children: "Terms" }, rect: { x: 0, y: 1200, w: 400, h: 40 } }],
        },
      ],
    };
    const root = screen(composite("ScrollView", { scrollTo: (a: any) => calls.push(a) }, fabricFiber(hosts)));
    const out = await scrollTo(root, 200, 1220);
    expect(out).toEqual({ scrolled: true, container: "ScrollView", method: "scrollTo" });
    expect(calls[0].y).toBe(1000);
    expect(calls[0].x).toBe(0); // the cross axis is preserved, not reset
    expect(calls[0].animated).toBe(false);
  });

  it("names an unrecognised scroll container instead of guessing at its API", async () => {
    const root = screen(
      composite(
        "CustomPager",
        {},
        fabricFiber({
          type: "RCTView",
          rect: { x: 0, y: 0, w: 400, h: 800 },
          children: [{ type: "RCTText", props: { children: "Slide 3" }, rect: { x: 420, y: 100, w: 400, h: 40 } }],
        }),
        { horizontal: true, onScroll: () => {} },
      ),
    );
    const out = await scrollTo(root, 620, 120);
    expect(out).toEqual({ scrolled: false, reason: "unrecognised scroll container: CustomPager" });
  });

  it("finds a scroll container 40 fibers up, behind styling wrappers (NativeWind/CssInterop)", async () => {
    const calls: any[] = [];
    // The wrappers sit where they do in the field: between the row's text and
    // the list's content view.
    const hosts: any = fabricFiber(LIST_HOSTS);
    const content = hosts.child;
    let row: any = content.child;
    for (let i = 0; i < 40; i++) row = composite("CssInterop.View", null, row);
    content.child = row;
    const root = screen(composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, hosts));
    const out = await scrollTo(root, 200, 920);
    expect(out).toEqual({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    expect(calls).toHaveLength(1);
  });

  it("says there is no scrollable ancestor when the element is not in a scroll view", async () => {
    const root = screen(
      fabricFiber({
        type: "RCTView",
        rect: { x: 0, y: 0, w: 400, h: 200 },
        children: [{ type: "RCTText", props: { children: "Header" }, rect: { x: 0, y: 0, w: 200, h: 40 } }],
      }),
    );
    const out = await scrollTo(root, 100, 20);
    expect(out.scrolled).toBe(false);
    expect((out as any).reason).toMatch(/no scrollable ancestor/);
  });

  it("survives a props object that throws on every read (Reanimated)", async () => {
    // The climb reads props on every ancestor to recognise a scroll container;
    // an animated wrapper between the row and the list throws on all of them.
    const calls: any[] = [];
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("[Reanimated] Trying to read an animated style");
        },
      },
    );
    const hosts: NodeSpec = {
      type: "RCTScrollView",
      rect: { x: 0, y: 100, w: 400, h: 600 },
      children: [
        {
          type: "RCTScrollContentView",
          rect: { x: 0, y: -400, w: 400, h: 3000 },
          children: [
            {
              type: "RCTView",
              props: throwing as any,
              rect: { x: 0, y: 890, w: 400, h: 60 },
              children: [{ type: "RCTText", props: { children: "Row 42" }, rect: { x: 0, y: 900, w: 400, h: 40 } }],
            },
          ],
        },
      ],
    };
    const root = screen(composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(hosts)));
    const out = await scrollTo(root, 200, 920);
    expect(out).toEqual({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    expect(calls[0].offset).toBe(1150);
  });
});

/**
 * D36. React keeps two fibers per node (current + alternate), and a child's
 * `return` pointer is free to name either one. Measured on demo-app's Trends
 * list (LegendList inside NativeWind wrappers, RN 0.83 Fabric): before the
 * first scroll every ancestor reached by `return` was the current fiber; after
 * it (the list re-rendered) every one from the row up to the list component
 * was the *alternate* — same stateNode, not the object the root walk visited.
 * The container's rect was looked up by fiber identity, so it was "found but
 * never measured" on 4 calls of 4.
 */
describe("scroll container reached through an alternate fiber (D36)", () => {
  /** Swaps `fiber` for a stale twin on the `return` path of its children, the way a re-render leaves it. */
  function staleTwin(fiber: any, parent: any): any {
    const alt = { ...fiber, alternate: fiber, child: null, sibling: null, return: parent };
    fiber.alternate = alt;
    for (let c = fiber.child; c; c = c.sibling) c.return = alt;
    return alt;
  }

  function hostScrollViewTree(calls: any[]) {
    const hosts: any = fabricFiber(LIST_HOSTS);
    // Fabric ScrollView: the scroll API is assigned onto the host's public instance.
    hosts.stateNode.canonical.publicInstance = { scrollTo: (a: any) => calls.push(a) };
    const wrapper = composite("CssInterop.ScrollView", null, hosts);
    const root = screen(wrapper);
    const wrapperAlt = staleTwin(wrapper, root);
    staleTwin(hosts, wrapperAlt);
    return root;
  }

  it("scroll_to measures the host scroll view when `return` leads to its alternate", async () => {
    const calls: any[] = [];
    const out = await scrollTo(hostScrollViewTree(calls), 200, 920);
    expect(out).toEqual({ scrolled: true, container: "RCTScrollView", method: "scrollTo" });
    expect(calls).toEqual([{ x: 0, y: 1150, animated: false }]);
  });

  it("swipe via js does too", async () => {
    const calls: any[] = [];
    // The finger lands on the row: the climb starts above the element hit.
    const out = await scrollBy(hostScrollViewTree(calls), 200, 920, 0, 200);
    expect(out).toEqual({ scrolled: true, container: "RCTScrollView", method: "scrollTo", from: 500, to: 700 });
    expect(calls).toEqual([{ x: 0, y: 700, animated: false }]);
  });

  it("finds the host below a composite list whose alternate has a stale child pointer", async () => {
    const calls: any[] = [];
    const list = composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(LIST_HOSTS));
    const root = screen(list);
    staleTwin(list, root); // alt.child === null: nothing measurable below the stale twin
    const out = await scrollTo(root, 200, 920);
    expect(out).toEqual({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    expect(calls[0].offset).toBe(1150);
  });
});

async function scrollBy(root: any, x: number, y: number, dx: number, dy: number): Promise<ScrollByResult> {
  const runtime = makeRuntime(hookGlobals(root, { fabric: true }));
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(scrollByExpression(x, y, dx, dy)));
}

/**
 * The swipe route. The point is the *start* of the gesture rather than a target
 * to reveal, and the delta is the content offset the finger would have produced:
 * a finger moving up drags the content up, which raises the offset.
 */
describe("scrollByExpression", () => {
  it("adds the delta to a FlatList's current offset", async () => {
    const calls: any[] = [];
    const root = screen(
      composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(LIST_HOSTS)),
    );
    // The point is anywhere over the list, not over the row: a swipe starts
    // wherever the finger lands.
    const out = await scrollBy(root, 200, 200, 0, 200);
    expect(out).toEqual({
      scrolled: true,
      container: "FlatList",
      method: "scrollToOffset",
      from: 500,
      to: 700,
    });
    expect(calls[0]).toEqual({ offset: 700, animated: false });
  });

  it("scrolls a ScrollView through scrollTo and preserves the cross axis", async () => {
    const calls: any[] = [];
    const hosts: NodeSpec = {
      type: "RCTScrollView",
      rect: { x: 0, y: 0, w: 400, h: 800 },
      children: [{ type: "RCTScrollContentView", rect: { x: 0, y: 0, w: 400, h: 2000 } }],
    };
    const root = screen(composite("ScrollView", { scrollTo: (a: any) => calls.push(a) }, fabricFiber(hosts)));
    const out = await scrollBy(root, 200, 400, 0, 640);
    expect(out).toMatchObject({ scrolled: true, container: "ScrollView", method: "scrollTo", from: 0, to: 640 });
    expect(calls[0]).toEqual({ x: 0, y: 640, animated: false });
  });

  it("never scrolls past the top of the content", async () => {
    const calls: any[] = [];
    const root = screen(
      composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(LIST_HOSTS)),
    );
    // A swipe down at the top of a list that is only 500pt in: the offset floors
    // at 0 rather than going negative, which RN would clamp anyway — but the
    // reported `to` must be the offset that was actually asked for.
    const out = await scrollBy(root, 200, 200, 0, -900);
    expect(out).toMatchObject({ from: 500, to: 0 });
    expect(calls[0].offset).toBe(0);
  });

  it("uses the horizontal delta when the container scrolls sideways", async () => {
    const calls: any[] = [];
    const hosts: NodeSpec = {
      type: "RCTScrollView",
      rect: { x: 0, y: 0, w: 400, h: 200 },
      children: [{ type: "RCTScrollContentView", rect: { x: -300, y: 0, w: 2000, h: 200 } }],
    };
    const root = screen(
      composite("FlatList", { scrollToOffset: (a: any) => calls.push(a) }, fabricFiber(hosts), {
        horizontal: true,
      }),
    );
    const out = await scrollBy(root, 200, 100, 150, 0);
    expect(out).toMatchObject({ scrolled: true, from: 300, to: 450 });
    expect(calls[0].offset).toBe(450);
  });

  it("prefers the live offset a VirtualizedList records over the measured one", async () => {
    const calls: any[] = [];
    const root = screen(
      composite(
        "FlatList",
        { scrollToOffset: (a: any) => calls.push(a), _scrollMetrics: { offset: 512 } },
        fabricFiber(LIST_HOSTS),
      ),
    );
    const out = await scrollBy(root, 200, 200, 0, 100);
    expect(out).toMatchObject({ from: 512, to: 612 });
  });

  it("calls RecyclerListView's positional scrollToOffset(x, y, animate)", async () => {
    const calls: any[][] = [];
    const root = screen(
      composite(
        "RecyclerListView",
        { scrollToOffset: (...a: any[]) => calls.push(a) },
        fabricFiber(LIST_HOSTS),
      ),
    );
    const out = await scrollBy(root, 200, 200, 0, 200);
    expect(out).toMatchObject({ scrolled: true, container: "RecyclerListView", to: 700 });
    expect(calls[0]).toEqual([0, 700, false]);
  });

  it("still lets a FlashList win over the RecyclerListView it renders", async () => {
    // The deferral this file has always applied: FlashList's own
    // scrollToOffset takes an object, and it is the component the caller wrote.
    const rlvCalls: any[][] = [];
    const flCalls: any[] = [];
    const root = screen(
      composite(
        "FlashList",
        { scrollToOffset: (a: any) => flCalls.push(a) },
        composite(
          "RecyclerListView",
          { scrollToOffset: (...a: any[]) => rlvCalls.push(a) },
          fabricFiber(LIST_HOSTS),
        ),
      ),
    );
    const out = await scrollBy(root, 200, 200, 0, 200);
    expect(out).toMatchObject({ scrolled: true, container: "FlashList" });
    expect(rlvCalls).toEqual([]);
    expect(flCalls[0]).toEqual({ offset: 700, animated: false });
  });

  it("names the point when nothing under it scrolls", async () => {
    const root = screen(
      fabricFiber({
        type: "RCTView",
        rect: { x: 0, y: 0, w: 400, h: 200 },
        children: [{ type: "RCTText", props: { children: "Header" }, rect: { x: 0, y: 0, w: 200, h: 40 } }],
      }),
    );
    const out = await scrollBy(root, 100, 20, 0, 200);
    expect(out.scrolled).toBe(false);
    expect((out as any).reason).toBe("no scroll container under 100,20");
  });
});
