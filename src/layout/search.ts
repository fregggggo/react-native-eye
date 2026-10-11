import { isVisible, type Element } from "./elements.js";

export type SearchOpts = {
  search: string[];
  type?: string;
  match?: "substring" | "exact";
  caseSensitive?: boolean;
};

export function searchElements(els: Element[], opts: SearchOpts): Element[] {
  const norm = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
  const terms = opts.search.map(norm);
  const matches = (field: string | undefined): boolean => {
    if (!field) return false;
    const f = norm(field);
    return terms.some((t) => (opts.match === "exact" ? f === t : f.includes(t)));
  };
  return els.filter((e) => {
    if (opts.type && e.type !== opts.type) return false;
    if (terms.length === 0) return true; // type-only filtering
    return matches(e.text) || matches(e.testID);
  });
}

/**
 * What is at this point on screen. Elements that are not visible (inactive tab,
 * covered, scrolled away) are never the answer — returning one is how a point on
 * a video feed came back as a label from a different tab. Among the rest the
 * later element wins: tree order is paint order, so the later one is on top.
 */
export function elementAtPoint(els: Element[], x: number, y: number): Element | undefined {
  const hit = (e: Element): boolean => {
    const b = e.visible ?? e;
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  };
  const containing = els.filter((e) => isVisible(e) && hit(e));
  if (containing.length === 0) return undefined;
  let best = containing[0];
  for (const e of containing) {
    const areaOf = (t: Element) => {
      const b = t.visible ?? t;
      return b.w * b.h;
    };
    // Later in the tree wins ties; a strictly smaller box wins outright.
    if (areaOf(e) <= areaOf(best)) best = e;
  }
  return best;
}
