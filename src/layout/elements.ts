import type { RawElement } from "../drivers/types.js";
import { UserInputError } from "../core/errors.js";

// D11: fastLayout also collects empty TextInputs (no testID/press/text of their
// own) so `get_layout({type:...})` and `into` can find "the input field on this
// screen". Extra fields, not on RawElement, so they don't have to be threaded
// through the OS-path (axe/uiautomator) elements that never carry them.
export type Element = RawElement & {
  cx: number;
  cy: number;
  /** Host is a text input (RCTSingle/MultilineTextInputView, AndroidTextInput, …). */
  input?: boolean;
  /** TextInput placeholder — stands in for `text` when the field is empty. */
  placeholder?: string;
  /** TextInput's current props.value, surfaced so `expect` can verify what was typed. */
  value?: string;
  /**
   * A testID borrowed from a decorative descendant, for a pressable with no
   * label of its own (D17). Display only — selectors still match the real
   * `testID` on the descendant, which resolves to the same point.
   */
  labelFrom?: string;
};

/**
 * The tap point is the centre of the *visible* part of the frame. An element
 * wider than the screen (or half-scrolled past an edge) has a geometric centre
 * that lies outside the display, and tapping there silently misses.
 */
export function toElements(raw: RawElement[]): Element[] {
  return raw.map((r) => {
    const box = r.visible ?? r;
    return { ...r, cx: Math.round(box.x + box.w / 2), cy: Math.round(box.y + box.h / 2) };
  });
}

/** On screen and actually rendered — the only elements that can be tapped or asserted on. */
export function isVisible(e: Element): boolean {
  return !e.offscreen && !e.hidden;
}

/**
 * Takes back a "LogBox covers the screen" verdict the OS did not confirm (field
 * test 3 D38): every element goes back to what it was before the overlay —
 * visible, on an inactive screen, or under a toast — and the inspector's own
 * elements become the hidden ones, because the window they would be in is not
 * on screen and an OS tap at their coordinates lands on the app instead.
 */
export function withdrawOverlay<T extends RawElement>(els: T[]): T[] {
  return els.map((e) => {
    if (e.overlay) return { ...e, hidden: true, hiddenBy: "window" as const };
    if (e.beneath === undefined) return e;
    const { beneath, ...rest } = e;
    const out = rest as T;
    if (beneath === "visible") {
      delete out.hidden;
      delete out.hiddenBy;
    } else {
      out.hidden = true;
      out.hiddenBy = beneath;
    }
    return out;
  });
}

function invisibleReason(e: Element): string {
  if (e.offscreen) return "scrolled out of view";
  if (e.hiddenBy === "window") return "in a LogBox window that is not on screen";
  if (e.hiddenBy === "covered") return "covered by another view, or on an inactive screen";
  return "hidden (display:none / opacity:0 / inactive screen)";
}

export function describeElement(e: Element): string {
  // D11: an empty TextInput has no text of its own — its placeholder is the
  // closest thing to a human label ("Email", "Search…"), so it stands in for
  // `text` here rather than falling straight through to testID/"?".
  // D17: a pressable with nothing of its own borrows the icon testID inside it,
  // marked "(icon)" so it is never mistaken for the element's own label.
  const own = e.text ?? e.placeholder ?? e.testID;
  const label = own ?? (e.labelFrom ? `${e.labelFrom} (icon)` : "?");
  const mark = isVisible(e) ? "" : ` (${e.offscreen ? "off-screen" : "hidden"})`;
  // Only inputs ever carry a value, so this never adds a column for anything else.
  const val = e.input && e.value ? ` = "${e.value}"` : "";
  return `${label} @${e.cx},${e.cy}${mark}${val}`;
}

function notVisibleError(what: string, els: Element[]): UserInputError {
  const where = els.map((e) => `@${e.cx},${e.cy} — ${invisibleReason(e)}`).join("; ");
  return new UserInputError(
    `${what} exists in the tree but is not visible (${where}). Scroll to it or navigate to its screen first.`,
  );
}

export function findByTestID(els: Element[], testID: string): Element | undefined {
  const all = els.filter((e) => e.testID === testID);
  const visible = all.filter(isVisible);
  if (visible.length > 1) {
    throw new UserInputError(
      `Ambiguous testID "${testID}" — ${visible.length} visible elements match (${visible
        .map((e) => `@${e.cx},${e.cy}`)
        .join(", ")}). testIDs should be unique; disambiguate with x+y.`,
    );
  }
  if (visible.length === 1) return visible[0];
  if (all.length > 0) throw notVisibleError(`testID "${testID}"`, all);
  return undefined;
}

export function findByText(els: Element[], text: string): Element {
  const pick = (matches: Element[], kind: string): Element | undefined => {
    if (matches.length === 0) return undefined;
    const allVisible = matches.filter(isVisible);
    // A container only ever borrowed its children's text, so it is never the
    // element the caller meant while a real one matches (D16). It stays
    // selectable when nothing else matches, which is what makes a screen whose
    // only label lives on a wrapper still addressable.
    const real = allVisible.filter((e) => !e.container);
    const visible = real.length > 0 ? real : allVisible;
    if (visible.length === 1) return visible[0];
    if (visible.length > 1) {
      // Duplicate labels are the dangerous case, not the harmless one: "Delete"
      // twice on one screen means picking the first is a coin flip.
      throw new UserInputError(
        `Ambiguous ${kind} "${text}" — ${visible.length} visible elements match: ${visible
          .map((e) => `"${e.text ?? e.placeholder}" @${e.cx},${e.cy}`)
          .join(", ")}. Use a testID, or tap by x+y.`,
      );
    }
    throw notVisibleError(`Text "${text}"`, matches);
  };

  const exact = pick(els.filter((e) => e.text === text), "text");
  if (exact) return exact;
  // An empty input is listed under its placeholder, so that is the label an
  // agent will reach for; real text still wins when both match (D11).
  const exactPh = pick(els.filter((e) => !e.text && e.placeholder === text), "placeholder");
  if (exactPh) return exactPh;
  const q = text.toLowerCase();
  const subs = pick(els.filter((e) => e.text && e.text.toLowerCase().includes(q)), "text match");
  if (subs) return subs;
  const subsPh = pick(
    els.filter((e) => !e.text && e.placeholder && e.placeholder.toLowerCase().includes(q)),
    "placeholder match",
  );
  if (subsPh) return subsPh;
  throw new UserInputError(`No element matching text "${text}".`);
}

/**
 * Present *and* visible. An element on an inactive tab measures exactly like the
 * one on screen, so without this an expect/wait_for passes on a screen the user
 * is not even looking at.
 */
export function isPresent(els: Element[], sel: { text?: string; testID?: string }): boolean {
  const visible = els.filter(isVisible);
  if (sel.testID) return visible.some((e) => e.testID === sel.testID);
  if (sel.text) {
    const q = sel.text.toLowerCase();
    // Matches what the listing shows: an empty input appears under its placeholder.
    return visible.some((e) => {
      const label = e.text ?? e.placeholder ?? "";
      return label === sel.text || label.toLowerCase().includes(q);
    });
  }
  return false;
}

function key(e: Element): string {
  // D17: key() is the *only* rendering an off-screen/hidden element ever gets
  // (formatLayout's off-screen/hidden summaries and layoutDiff's moved lines
  // read it directly — describeElement, which marks a borrowed label, never
  // runs on them because formatLayout filters to isVisible first). Mirroring
  // describeElement's own-label-first, "(icon)"-marked fallback here means a
  // borrowed label reads as borrowed everywhere it can surface, not just in
  // the primary listing. Marking both sides of a diff identically keeps
  // layoutDiff's before/after Map lookup matching the same element by the
  // same key — only the rendered text changes, not which elements pair up.
  const own = e.text ?? e.placeholder ?? e.testID;
  return own ?? (e.labelFrom ? `${e.labelFrom} (icon)` : `${e.cx},${e.cy}`);
}

// Cap on an explicit-search listing (opts.listAll). The suppression rules this
// bypasses exist to keep an *unfiltered* screen readable; a caller who named
// what they want still deserves a bound when the name happens to match a huge
// number of elements, or "list every match" (D8) just trades one unreadable
// wall of text (a count) for another (an unbounded dump).
const LIST_ALL_CAP = 50;

export function formatLayout(els: Element[], opts?: { listAll?: boolean }): string {
  if (els.length === 0) return "(no interactive elements found)";
  // An explicit search or type filter already named what it wants. Collapsing
  // a hit into "(+1 …)" there answered a question with a count (field test
  // D8); each element's own status suffix (from describeElement) carries the
  // same information without hiding the match.
  if (opts?.listAll) {
    const shown = els.slice(0, LIST_ALL_CAP).map(describeElement);
    if (els.length > LIST_ALL_CAP) {
      shown.push(`(+${els.length - LIST_ALL_CAP} more matches not shown — narrow the search)`);
    }
    return shown.join("\n");
  }
  const visible = els.filter(isVisible);
  const listed = visible.filter((e) => !e.decorative && !e.container);
  const lines = listed.map(describeElement);

  const suppressed = visible.length - listed.length;
  if (suppressed > 0) lines.push(`(+${suppressed} decorative/container elements — searchable and tappable, not listed)`);

  const off = els.filter((e) => e.offscreen);
  if (off.length > 0) {
    lines.push(`(+${off.length} off-screen: ${off.slice(0, 5).map(key).join(", ")}${off.length > 5 ? ", …" : ""})`);
  }
  const hidden = els.filter((e) => e.hidden && !e.offscreen);
  if (hidden.length > 0) {
    lines.push(
      `(+${hidden.length} on hidden screens/covered: ${hidden.slice(0, 5).map(key).join(", ")}${hidden.length > 5 ? ", …" : ""})`,
    );
  }
  return lines.length ? lines.join("\n") : "(no visible interactive elements)";
}

export function layoutDiff(before: Element[], after: Element[]): string {
  const vis = (els: Element[]) => els.filter(isVisible);
  const bByKey = new Map(vis(before).map((e) => [key(e), e]));
  const aByKey = new Map(vis(after).map((e) => [key(e), e]));
  const added = vis(after).filter((e) => !bByKey.has(key(e))).map((e) => `+ ${describeElement(e)}`);
  const removed = vis(before).filter((e) => !aByKey.has(key(e))).map((e) => `- ${describeElement(e)}`);
  // Same elements at new positions (a scroll, a collapsing header) is a real
  // change; reporting only add/remove made it look like nothing happened.
  const moved: string[] = [];
  for (const [k, b] of bByKey) {
    const a = aByKey.get(k);
    if (a && (Math.abs(a.cx - b.cx) > 4 || Math.abs(a.cy - b.cy) > 4)) {
      moved.push(`~ ${k} ${b.cx},${b.cy} → ${a.cx},${a.cy}`);
    }
  }
  const lines = [...added, ...removed, ...moved.slice(0, 10)];
  if (moved.length > 10) lines.push(`~ (+${moved.length - 10} more moved)`);
  return lines.length ? lines.join("\n") : "(no visible layout change)";
}
