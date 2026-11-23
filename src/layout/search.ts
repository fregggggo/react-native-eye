import { isVisible, type Element } from "./elements.js";

export type SearchOpts = {
  search: string[];
  type?: string;
  match?: "substring" | "exact";
  caseSensitive?: boolean;
};

/**
 * The words a caller reaches for, mapped onto what the two capture paths call
 * things: RN host names on the JS path (RCTSinglelineTextInputView, RCTText),
 * XCUI/axe roles on iOS (TextField, StaticText, Button), Android widget classes
 * through uiautomator (android.widget.EditText). Live: `type: "input"` and
 * `type: "TextInput"` both returned nothing on a screen with three fields.
 */
const TYPE_ALIASES: Record<string, (e: Element) => boolean> = {
  // UITextView's role is "TextView" (editable); Android's TextView is static.
  input: (e) =>
    e.input === true ||
    (/TextInput|EditText|TextField|SearchField|^TextView$/i.test(e.type ?? "") && !/StaticText/i.test(e.type ?? "")),
  text: (e) =>
    e.input !== true &&
    /(Text|TextView|Label)$/i.test(e.type ?? "") &&
    !/TextInput|EditText|TextField|^TextView$/i.test(e.type ?? ""),
  button: (e) => e.pressable === true || /Button/i.test(e.type ?? ""),
  image: (e) => /Image/i.test(e.type ?? ""),
  scroll: (e) => /Scroll|RecyclerView|ListView|CollectionView|Table/i.test(e.type ?? ""),
};
TYPE_ALIASES.textinput = TYPE_ALIASES.input;
TYPE_ALIASES.textfield = TYPE_ALIASES.input;
TYPE_ALIASES.field = TYPE_ALIASES.input;
TYPE_ALIASES.label = TYPE_ALIASES.text;
TYPE_ALIASES.pressable = TYPE_ALIASES.button;
TYPE_ALIASES.touchable = TYPE_ALIASES.button;
TYPE_ALIASES.img = TYPE_ALIASES.image;
TYPE_ALIASES.scrollview = TYPE_ALIASES.scroll;
TYPE_ALIASES.list = TYPE_ALIASES.scroll;

/** The aliases `type` accepts on top of exact host names, for error text. */
export const TYPE_ALIAS_NAMES = ["input", "text", "button", "image", "scroll"];

/** Whether `e` is of the requested type: an alias, or a host/role name (case-insensitive). */
export function matchesType(e: Element, type: string): boolean {
  const t = type.trim().toLowerCase();
  if (!t) return true;
  if ((e.type ?? "").toLowerCase() === t) return true;
  const alias = Object.prototype.hasOwnProperty.call(TYPE_ALIASES, t) ? TYPE_ALIASES[t] : undefined;
  return alias ? alias(e) : false;
}

/** The element types in `els` with their counts, most common first — for a filter that matched nothing. */
export function typesPresent(els: Element[]): string {
  const counts = new Map<string, number>();
  for (const e of els) {
    if (!e.type) continue;
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t} (${n})`)
    .join(", ");
}

export function searchElements(els: Element[], opts: SearchOpts): Element[] {
  const norm = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
  const terms = opts.search.map(norm);
  const matches = (field: string | undefined): boolean => {
    if (!field) return false;
    const f = norm(field);
    return terms.some((t) => (opts.match === "exact" ? f === t : f.includes(t)));
  };
  return els.filter((e) => {
    if (opts.type && !matchesType(e, opts.type)) return false;
    if (terms.length === 0) return true; // type-only filtering
    // An empty input is listed under its placeholder, so that is a name the
    // caller will search by.
    return matches(e.text) || matches(e.testID) || matches(e.placeholder);
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
