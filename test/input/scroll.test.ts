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
    const move = mover(hosts);
    hosts.stateNode.canonical.publicInstance = {
      scrollTo: (a: any) => {
        calls.push(a);
        move(a.y);
      },
    };
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

/**
 * The By route reads the container again after scrolling and reports a scroll
 * that did not move as a failure, so a fake scroll API has to move the content
 * view the way the native side does. Assigns a fresh rect: the spec rects are
 * shared constants.
 */
function mover(hosts: any, horizontal = false) {
  const frame = hosts.stateNode.node.__rect;
  const content = hosts.child;
  return (offset: number) => {
    const r = content.stateNode.node.__rect;
    content.stateNode.node.__rect = horizontal ? { ...r, x: frame.x - offset } : { ...r, y: frame.y - offset };
  };
}

/** A FlatList-shaped instance whose scrollToOffset moves `hosts`' content. */
function movingList(hosts: any, calls: any[], extra: Record<string, unknown> = {}, horizontal = false) {
  const move = mover(hosts, horizontal);
  return {
    scrollToOffset: (a: any) => {
      calls.push(a);
      move(a.offset);
    },
    ...extra,
  };
}

/** A ScrollView-shaped instance whose scrollTo moves `hosts`' content. */
function movingScrollView(hosts: any, calls: any[], horizontal = false) {
  const move = mover(hosts, horizontal);
  return {
    scrollTo: (a: any) => {
      calls.push(a);
      move(horizontal ? a.x : a.y);
    },
  };
}

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
    const hosts = fabricFiber(LIST_HOSTS);
    const root = screen(composite("FlatList", movingList(hosts, calls), hosts));
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
    const fiber = fabricFiber(hosts);
    const root = screen(composite("ScrollView", movingScrollView(fiber, calls), fiber));
    const out = await scrollBy(root, 200, 400, 0, 640);
    expect(out).toMatchObject({ scrolled: true, container: "ScrollView", method: "scrollTo", from: 0, to: 640 });
    expect(calls[0]).toEqual({ x: 0, y: 640, animated: false });
  });

  it("never scrolls past the top of the content", async () => {
    const calls: any[] = [];
    const hosts = fabricFiber(LIST_HOSTS);
    const root = screen(composite("FlatList", movingList(hosts, calls), hosts));
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
    const fiber = fabricFiber(hosts);
    const root = screen(composite("FlatList", movingList(fiber, calls, {}, true), fiber, { horizontal: true }));
    const out = await scrollBy(root, 200, 100, 150, 0);
    expect(out).toMatchObject({ scrolled: true, from: 300, to: 450 });
    expect(calls[0].offset).toBe(450);
  });

  it("prefers the live offset a VirtualizedList records over the measured one", async () => {
    const calls: any[] = [];
    const hosts = fabricFiber(LIST_HOSTS);
    const root = screen(composite("FlatList", movingList(hosts, calls, { _scrollMetrics: { offset: 512 } }), hosts));
    const out = await scrollBy(root, 200, 200, 0, 100);
    expect(out).toMatchObject({ from: 512, to: 612 });
  });

  it("calls RecyclerListView's positional scrollToOffset(x, y, animate)", async () => {
    const calls: any[][] = [];
    const hosts = fabricFiber(LIST_HOSTS);
    const move = mover(hosts);
    const root = screen(
      composite(
        "RecyclerListView",
        {
          scrollToOffset: (...a: any[]) => {
            calls.push(a);
            move(a[1]);
          },
        },
        hosts,
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
    const hosts = fabricFiber(LIST_HOSTS);
    const root = screen(
      composite(
        "FlashList",
        movingList(hosts, flCalls),
        composite("RecyclerListView", { scrollToOffset: (...a: any[]) => rlvCalls.push(a) }, hosts),
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

/** A tall list: frame 0-800, content 2000 tall, scrolled `offset` down. */
function tallList(offset: number, props: Record<string, unknown> = {}) {
  const hosts = fabricFiber({
    type: "RCTScrollView",
    rect: { x: 0, y: 0, w: 400, h: 800 },
    children: [{ type: "RCTScrollContentView", rect: { x: 0, y: -offset, w: 400, h: 2000 } }],
  });
  const calls: any[] = [];
  const root = screen(composite("ScrollView", movingScrollView(hosts, calls), hosts, props));
  return { root, calls };
}

/** A horizontal pager: frame 400 wide, four pages, at `offset`. */
function pager(offset: number, props: Record<string, unknown>) {
  const hosts = fabricFiber({
    type: "RCTScrollView",
    rect: { x: 0, y: 100, w: 400, h: 300 },
    children: [{ type: "RCTScrollContentView", rect: { x: -offset, y: 100, w: 1600, h: 300 } }],
  });
  const calls: any[] = [];
  const root = screen(composite("ScrollView", movingScrollView(hosts, calls, true), hosts, { horizontal: true, ...props }));
  return { root, calls };
}

describe("scrollByExpression: where the content can actually go", () => {
  it("moves a pagingEnabled scroll view one whole page, not to an offset between pages", async () => {
    // Live: a 478px swipe on a pager came back "scrollTo 0 → 478" twice while
    // nothing moved.
    const { root, calls } = pager(0, { pagingEnabled: true });
    const out = await scrollBy(root, 200, 250, 478, 0);
    expect(out).toMatchObject({ scrolled: true, from: 0, to: 400 });
    expect(calls[0]).toEqual({ x: 400, y: 0, animated: false });
  });

  it("moves a pager one page even for a short fling, and back again", async () => {
    const fwd = pager(400, { pagingEnabled: true });
    expect(await scrollBy(fwd.root, 200, 250, 60, 0)).toMatchObject({ scrolled: true, from: 400, to: 800 });
    const back = pager(400, { pagingEnabled: true });
    expect(await scrollBy(back.root, 200, 250, -60, 0)).toMatchObject({ scrolled: true, from: 400, to: 0 });
  });

  it("rests on the nearest snapToInterval / snapToOffsets point", async () => {
    const interval = tallList(0, { snapToInterval: 300 });
    expect(await scrollBy(interval.root, 200, 400, 0, 478)).toMatchObject({ scrolled: true, to: 600 });
    const offsets = tallList(0, { snapToOffsets: [900, 0, 250] });
    expect(await scrollBy(offsets.root, 200, 400, 0, 478)).toMatchObject({ scrolled: true, to: 250 });
  });

  it("stops at the end of the content and reports where it really went", async () => {
    // 2000 of content in an 800 frame ends at 1200.
    const { root, calls } = tallList(1100);
    const out = await scrollBy(root, 200, 400, 0, 640);
    expect(out).toMatchObject({ scrolled: true, from: 1100, to: 1200 });
    expect(calls[0].y).toBe(1200);
  });

  it("refuses instead of reporting a scroll when the content is already at the end", async () => {
    const { root, calls } = tallList(1200);
    const out = await scrollBy(root, 200, 400, 0, 300);
    expect(out.scrolled).toBe(false);
    expect((out as any).reason).toMatch(/already at the end \(offset 1200 of 1200\)/);
    expect(calls).toEqual([]);
  });

  it("reports a scroll whose call returned but whose content never moved as a failure", async () => {
    const calls: any[] = [];
    const root = screen(
      composite("ScrollView", { scrollTo: (a: any) => calls.push(a) }, fabricFiber(LIST_HOSTS), { pagingEnabled: false }),
    );
    const out = await scrollBy(root, 200, 200, 0, 200);
    expect(calls).toHaveLength(1);
    expect(out.scrolled).toBe(false);
    expect((out as any).reason).toMatch(/ScrollView\.scrollTo\(700\) returned but the content did not move \(still at 500\)/);
  });
});

describe("scrollByExpression: which container the finger is on", () => {
  it("scrolls the list on screen, not the same list on a hidden screen mounted at the same place", async () => {
    // A stack keeps the screen below mounted at identical coordinates; it is
    // walked first, and its row is the smaller frame under the finger.
    const hiddenCalls: any[] = [];
    const shownCalls: any[] = [];
    const listIn = (calls: any[]) => {
      const hosts = fabricFiber({
        type: "RCTScrollView",
        rect: { x: 0, y: 0, w: 400, h: 800 },
        children: [
          {
            type: "RCTScrollContentView",
            rect: { x: 0, y: 0, w: 400, h: 3000 },
            children: [{ type: "RCTText", props: { children: "Row" }, rect: { x: 0, y: 570, w: 400, h: 60 } }],
          },
        ],
      });
      return composite("FlatList", movingList(hosts, calls), hosts);
    };
    const scene = (focused: boolean, calls: any[]) => {
      const s = composite("SceneView", null, listIn(calls), { focused, descriptor: {} });
      return s;
    };
    const below = scene(false, hiddenCalls);
    below.sibling = scene(true, shownCalls);
    const out = await scrollBy(screen(below), 200, 600, 0, 300);
    expect(out).toMatchObject({ scrolled: true, from: 0, to: 300 });
    expect(hiddenCalls).toEqual([]);
    expect(shownCalls).toHaveLength(1);
  });

  it("gives a vertical swipe on a horizontal carousel to the vertical list around it", async () => {
    const make = () => {
      const listCalls: any[] = [];
      const carouselCalls: any[] = [];
      const carouselHosts = fabricFiber({
        type: "RCTScrollView",
        rect: { x: 0, y: 200, w: 400, h: 200 },
        children: [
          {
            type: "RCTScrollContentView",
            rect: { x: 0, y: 200, w: 1600, h: 200 },
            children: [{ type: "RCTText", props: { children: "Card" }, rect: { x: 10, y: 210, w: 300, h: 180 } }],
          },
        ],
      });
      const carousel = composite("FlatList", movingList(carouselHosts, carouselCalls, {}, true), carouselHosts, {
        horizontal: true,
      });
      const listHosts = fabricFiber({
        type: "RCTScrollView",
        rect: { x: 0, y: 0, w: 400, h: 800 },
        children: [{ type: "RCTScrollContentView", rect: { x: 0, y: 0, w: 400, h: 3000 } }],
      });
      listHosts.child.child = carousel;
      const list = composite("FlatList", movingList(listHosts, listCalls), listHosts);
      return { root: screen(list), listCalls, carouselCalls };
    };
    const v = make();
    expect(await scrollBy(v.root, 200, 300, 0, 300)).toMatchObject({ scrolled: true, from: 0, to: 300 });
    expect(v.carouselCalls).toEqual([]);
    expect(v.listCalls).toHaveLength(1);

    const h = make();
    expect(await scrollBy(h.root, 200, 300, 300, 0)).toMatchObject({ scrolled: true, from: 0, to: 300 });
    expect(h.listCalls).toEqual([]);
    expect(h.carouselCalls).toHaveLength(1);
  });

  it("says when the only container under the finger scrolls the other way", async () => {
    const { root } = pager(0, {});
    const out = await scrollBy(root, 200, 250, 0, 300);
    expect(out.scrolled).toBe(false);
    expect((out as any).reason).toMatch(/no vertical scroll container under 200,250 \(ScrollView there scrolls horizontally\)/);
  });
});

describe("scrollToExpression: the named target", () => {
  it("finds the target under a tab bar painted over its centre", async () => {
    const calls: any[] = [];
    const hosts = fabricFiber({
      type: "RCTScrollView",
      rect: { x: 0, y: 0, w: 400, h: 700 },
      children: [
        {
          type: "RCTScrollContentView",
          rect: { x: 0, y: 0, w: 400, h: 2000 },
          children: [{ type: "RCTText", props: { children: "Row 15" }, rect: { x: 0, y: 740, w: 400, h: 40 } }],
        },
      ],
    });
    const list = composite("FlatList", movingList(hosts, calls), hosts);
    // A bigger frame first, then the tab bar: smallest-area alone would pick
    // the tab bar label, which is smaller than the row.
    list.sibling = fabricFiber({ type: "RCTText", props: { children: "Home" }, rect: { x: 150, y: 750, w: 100, h: 20 } });
    const runtime = makeRuntime(hookGlobals(screen(list), { fabric: true }));
    const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
    const out = JSON.parse(await conn.evaluate(scrollToExpression(200, 760, { text: "Row 15" })));
    expect(out).toEqual({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    expect(calls[0].offset).toBe(565);
  });
});
