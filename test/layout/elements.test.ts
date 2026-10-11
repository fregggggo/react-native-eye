import { describe, it, expect } from "vitest";
import {
  toElements,
  findByText,
  findByTestID,
  layoutDiff,
  formatLayout,
  isPresent,
  describeElement,
  type Element,
} from "../../src/layout/elements.js";

const raw = [
  { text: "Login", x: 0, y: 0, w: 100, h: 40 },
  { text: "Login again", x: 0, y: 50, w: 100, h: 40 },
  { testID: "email", x: 0, y: 100, w: 200, h: 30 },
];

describe("elements", () => {
  it("computes center points", () => {
    expect(toElements(raw)[0]).toMatchObject({ cx: 50, cy: 20 });
  });

  it("findByTestID matches", () => {
    expect(findByTestID(toElements(raw), "email")?.testID).toBe("email");
  });

  it("findByText prefers exact match over substring", () => {
    const el = findByText(toElements(raw), "Login");
    expect(el.cy).toBe(20); // the exact "Login", not "Login again"
  });

  it("findByText throws listing candidates on ambiguous substring", () => {
    expect(() => findByText(toElements(raw), "Logi")).toThrow(/Login|candidates/i);
  });

  it("findByText throws when nothing matches", () => {
    expect(() => findByText(toElements(raw), "Nope")).toThrow(/no element/i);
  });

  it("picks the real element over the container that borrowed its label", () => {
    const els = toElements([
      { text: "For You", x: 0, y: 70, w: 400, h: 28 },
      { text: "For You", x: 140, y: 70, w: 40, h: 28 },
    ]) as Element[];
    els[0].container = true;
    // Field test D16: with only one tab rendered the wrapper's glued label is
    // exactly the tab's, and tap() saw two visible matches.
    expect(findByText(els, "For You").cx).toBe(160);
  });

  it("returns the container itself when it is the only match for its text", () => {
    // A screen whose only label lives on a wrapper (no separate real element
    // ever matched) must stay addressable — the container preference is a
    // tiebreaker, not an exclusion.
    const els = toElements([{ text: "Header", x: 0, y: 0, w: 400, h: 40 }]) as Element[];
    els[0].container = true;
    expect(findByText(els, "Header").cx).toBe(200);
  });

  it("layoutDiff reports additions and removals", () => {
    const before = toElements([{ text: "A", x: 0, y: 0, w: 1, h: 1 }]);
    const after = toElements([{ text: "B", x: 0, y: 0, w: 1, h: 1 }]);
    const diff = layoutDiff(before, after);
    expect(diff).toContain("+ B");
    expect(diff).toContain("- A");
  });

  it("formatLayout is compact", () => {
    expect(formatLayout(toElements(raw))).toContain("Login @50,20");
  });
});

describe("borrowed icon labels (D17)", () => {
  it("describes a borrowed icon label as borrowed", () => {
    const [el] = toElements([{ x: 40, y: 810, w: 32, h: 32 }]) as Element[];
    el.labelFrom = "extra-icon-play-square-bold";
    expect(describeElement(el)).toBe("extra-icon-play-square-bold (icon) @56,826");
  });

  it("never lets a borrowed label override an element's own text or testID", () => {
    const [el] = toElements([{ testID: "back-button", x: 40, y: 810, w: 32, h: 32 }]) as Element[];
    // Defence in depth: fastLayout never sets labelFrom alongside an own
    // testID, but describeElement/key must not rely on that alone — an
    // element's own label always wins over a borrowed one.
    el.labelFrom = "extra-icon-play-square-bold";
    expect(describeElement(el)).toBe("back-button @56,826");
  });

  it('shows "?" rather than inventing a label when nothing is identifiable', () => {
    const [el] = toElements([{ x: 40, y: 810, w: 32, h: 32 }]) as Element[];
    expect(describeElement(el)).toBe("? @56,826");
  });

  it("distinguishes two different icon buttons across a diff even when they swap positions", () => {
    const before = toElements([
      { labelFrom: "icon-back", x: 20, y: 10, w: 20, h: 20 },
      { labelFrom: "icon-share", x: 120, y: 10, w: 20, h: 20 },
    ] as any) as Element[];
    const after = toElements([
      { labelFrom: "icon-back", x: 120, y: 10, w: 20, h: 20 },
      { labelFrom: "icon-share", x: 20, y: 10, w: 20, h: 20 },
    ] as any) as Element[];
    const diff = layoutDiff(before, after);
    // A coordinate-only identity would see the two swap and misreport each
    // button as having moved into the position vacated by the *other* one —
    // key() must fall back to the borrowed label so a swap reads as two
    // correctly-attributed moves, not a confusion between the two buttons.
    // The label is marked "(icon)" here too (fix round 1): key() is the only
    // rendering a moved line ever gets, so an unmarked bare testID here would
    // be indistinguishable from a real one.
    expect(diff).toContain("icon-back (icon) 30,20 → 130,20");
    expect(diff).toContain("icon-share (icon) 130,20 → 30,20");
    // Explicitly rule out the regression the marking change could cause: if
    // marking broke before/after matching, this would collapse to "no visible
    // layout change" instead of reporting the two moves.
    expect(diff).not.toBe("(no visible layout change)");
  });

  it("marks a borrowed label in the off-screen/hidden summary too, since describeElement never renders it", () => {
    // formatLayout filters to isVisible before calling describeElement, so an
    // off-screen or hidden borrowing element is never described — key() is
    // its only rendering. Without the same "(icon)" marking here, exactly the
    // elements the agent cannot see would show a borrowed testID dressed as
    // the element's own identifier (fix round 1 finding).
    const [el] = toElements([
      { labelFrom: "icon-back", x: 20, y: 2400, w: 20, h: 20, offscreen: true },
    ] as any) as Element[];
    const out = formatLayout([el]);
    expect(out).toContain("icon-back (icon)");
  });
});

describe("ambiguity and visibility", () => {
  const el = (text: string, cy: number, offscreen = false) => ({
    text, x: 0, y: cy, w: 100, h: 20, cx: 50, cy, offscreen: offscreen || undefined,
  });

  it("refuses to guess between identical labels", () => {
    // Exact duplicates ("Delete" twice) are the dangerous case; the old code
    // returned the first one silently.
    const els = [el("Delete", 100), el("Delete", 300)] as any;
    expect(() => findByText(els, "Delete")).toThrow(/Ambiguous text "Delete" — 2 visible elements/);
  });

  it("prefers the visible match over an off-screen duplicate", () => {
    const els = [el("Save", 2400, true), el("Save", 200)] as any;
    expect(findByText(els, "Save").cy).toBe(200);
  });

  it("explains that the only match is scrolled out of view", () => {
    const els = [el("Save", 2400, true)] as any;
    expect(() => findByText(els, "Save")).toThrow(/not visible.*scrolled out of view/s);
  });

  it("does not count an off-screen element as present", () => {
    const els = [el("Welcome", 2400, true)] as any;
    expect(isPresent(els, { text: "Welcome" })).toBe(false);
    expect(isPresent([el("Welcome", 200)] as any, { text: "Welcome" })).toBe(true);
  });

  it("flags duplicate testIDs rather than picking one", () => {
    const a: any = { testID: "row", x: 0, y: 0, w: 10, h: 10, cx: 5, cy: 5 };
    const b: any = { testID: "row", x: 0, y: 50, w: 10, h: 10, cx: 5, cy: 55 };
    expect(() => findByTestID([a, b], "row")).toThrow(/Ambiguous testID/);
  });

  it("lists off-screen elements separately in the formatted layout", () => {
    const out = formatLayout([el("Visible", 100), el("Hidden", 2400, true)] as any);
    expect(out).toContain("Visible @50,100");
    expect(out).toContain("off-screen");
  });

  it("reports movement, not just add/remove", () => {
    // A scroll moves the same elements; the old diff called that "no change".
    const before = [el("Row 1", 100), el("Row 2", 200)] as any;
    const after = [el("Row 1", 40), el("Row 2", 140)] as any;
    const diff = layoutDiff(before, after);
    expect(diff).not.toBe("(no visible layout change)");
    expect(diff).toContain("Row 1 50,100 → 50,40");
  });
});

describe("text input elements (D11)", () => {
  it("uses the placeholder as the label when the input has no text", () => {
    const els = toElements([
      { type: "RCTSinglelineTextInputView", input: true, placeholder: "Email", x: 0, y: 100, w: 200, h: 40 } as any,
    ]);
    expect(formatLayout(els)).toContain("Email @100,120");
  });

  it("surfaces the current value on an input without adding noise to other elements", () => {
    const els = toElements([
      {
        type: "RCTSinglelineTextInputView",
        input: true,
        placeholder: "Email",
        value: "cat",
        x: 0,
        y: 100,
        w: 200,
        h: 40,
      } as any,
      { text: "Login", x: 0, y: 0, w: 100, h: 40 },
    ]);
    const out = formatLayout(els);
    expect(out).toContain('Email @100,120 = "cat"');
    expect(out).not.toMatch(/Login[^\n]*=/);
  });

  it("prefers real text over the placeholder when both are present", () => {
    const els = toElements([
      {
        type: "RCTSinglelineTextInputView",
        input: true,
        text: "typed already",
        placeholder: "Email",
        x: 0,
        y: 100,
        w: 200,
        h: 40,
      } as any,
    ]);
    expect(formatLayout(els)).toContain("typed already @100,120");
  });
});

describe("tap point clipping", () => {
  it("centres on the visible part of an oversized element", () => {
    // Full frame centre would be x≈5420 on a 440pt screen: a guaranteed miss.
    const [e] = toElements([
      { text: "Try it free", x: 20, y: 380, w: 10800, h: 26, visible: { x: 20, y: 380, w: 420, h: 26 } },
    ]);
    expect(e.cx).toBe(230);
    expect(e.cy).toBe(393);
  });

  it("falls back to the full frame when nothing was clipped", () => {
    const [e] = toElements([{ text: "Normal", x: 0, y: 0, w: 100, h: 40 }]);
    expect([e.cx, e.cy]).toEqual([50, 20]);
  });

  it("treats a hidden element as absent for expect/wait_for", () => {
    const els = toElements([{ text: "Публикации", x: 0, y: 260, w: 200, h: 24, hidden: true }]);
    expect(isPresent(els, { text: "Публикации" })).toBe(false);
  });

  it("explains that a match is on a hidden screen", () => {
    const els = toElements([
      { text: "Публикации", x: 0, y: 260, w: 200, h: 24, hidden: true, hiddenBy: "covered" },
    ]);
    expect(() => findByText(els, "Публикации")).toThrow(/not visible.*covered by another view/s);
  });

  // The listing shows an empty input under its placeholder, so that label is
  // what an agent will reach for — matching it is not optional (field test D11).
  it("finds an empty input by the placeholder shown as its label", () => {
    const els = toElements([
      { placeholder: "Email", input: true, x: 0, y: 100, w: 200, h: 40 } as any,
    ]);
    expect(findByText(els, "Email").cy).toBe(120);
  });

  it("prefers a real text match over a placeholder match", () => {
    const els = toElements([
      { placeholder: "Search", input: true, x: 0, y: 100, w: 200, h: 40 } as any,
      { text: "Search", x: 0, y: 300, w: 100, h: 40 },
    ]);
    expect(findByText(els, "Search").cy).toBe(320);
  });

  it("counts a placeholder as present for expect/wait_for", () => {
    const els = toElements([
      { placeholder: "Email", input: true, x: 0, y: 100, w: 200, h: 40 } as any,
    ]);
    expect(isPresent(els, { text: "Email" })).toBe(true);
  });

  it("omits decorative and container entries from the listing but counts them", () => {
    const els = toElements([
      { text: "Подписки", x: 0, y: 60, w: 100, h: 40 },
      { text: "ПодпискиДля вас", x: 0, y: 60, w: 400, h: 40, container: true },
      { testID: "icon-heart", x: 10, y: 10, w: 20, h: 20, decorative: true },
    ]);
    const out = formatLayout(els);
    expect(out).toContain("Подписки @50,80");
    expect(out).not.toContain("ПодпискиДля вас");
    expect(out).toContain("+2 decorative/container");
  });
});

describe("explicit search lists all matches (D8)", () => {
  it("lists every match when the caller asked for these elements by name", () => {
    const els = toElements([
      { testID: "extra-icon-play-square-bold", x: 40, y: 810, w: 24, h: 24 },
    ]) as Element[];
    els[0].decorative = true;
    els[0].hidden = true;
    els[0].hiddenBy = "covered";
    const out = formatLayout(els, { listAll: true });
    // Field test D8: an explicit search reported its own hit as "(+1 …)".
    expect(out).toContain("extra-icon-play-square-bold @52,822");
    expect(out).not.toMatch(/^\(\+/m);
  });

  it("bounds an explicit listing when the search matches a large number of elements", () => {
    // The suppression rules exist to keep an unfiltered screen readable; an
    // explicit search that happens to match a huge number of elements (a
    // generic substring on a long list) still needs a bound, or the "list
    // every match" fix just moves the unreadable wall of text from a count to
    // a dump.
    const els = toElements(
      Array.from({ length: 80 }, (_, i) => ({ testID: `icon-${i}`, x: 0, y: i * 10, w: 20, h: 20 })),
    ) as Element[];
    const out = formatLayout(els, { listAll: true });
    const lines = out.split("\n");
    // 50 listed elements + one bound-reached summary line naming why the rest
    // were cut and what to do about it.
    expect(lines).toHaveLength(51);
    expect(out).toContain("icon-0 @10,10");
    expect(out).toContain("icon-49 @10,500");
    expect(out).not.toContain("icon-50 ");
    expect(out).toContain("(+30 more matches not shown — narrow the search)");
  });
});
