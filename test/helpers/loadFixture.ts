import { readFileSync } from "node:fs";
import { linkParents } from "./fiberTree.js";

export type FixtureProps = {
  testID?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityElementsHidden?: boolean;
  ariaHidden?: boolean;
  importantForAccessibility?: string;
  activityState?: number;
  focused?: boolean;
  index?: number;
  navigationIndex?: number;
  display?: string;
  childrenText?: string;
  styleDisplay?: string;
  styleOpacity?: number;
  styleThrows?: boolean;
  hasValue?: boolean;
  value?: string;
  onPress?: boolean;
  onLongPress?: boolean;
  onClick?: boolean;
  onChangeText?: boolean;
  onStartShouldSetResponder?: boolean;
};

export type FixtureNode = {
  /** Index into `nodes` — always equal to the array position. */
  i: number;
  /** Parent index, -1 for a fiber root. */
  parent: number;
  name: string;
  host: boolean;
  props: FixtureProps;
  rect?: { x: number; y: number; w: number; h: number };
};

export type FiberFixture = { meta: Record<string, unknown>; nodes: FixtureNode[] };

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;
}

function throwsOnRead(): Record<string, unknown> {
  const animated = {};
  const get = () => {
    throw new Error("[Reanimated] Trying to read an animated style from the JS thread");
  };
  Object.defineProperty(animated, "display", { get, enumerable: true });
  Object.defineProperty(animated, "opacity", { get, enumerable: true });
  return animated;
}

/**
 * One flag comes back as the shape the walkers actually traverse: the animated
 * member sits next to the static one when both were seen, and is the whole style
 * when it was not. Which level the throw came from does not matter — both are
 * behind the same `safe()` in the walker, and reproducing a read that throws is
 * the point.
 */
function styleFor(p: FixtureProps): unknown {
  const plain: Record<string, unknown> = {};
  if (p.styleDisplay !== undefined) plain.display = p.styleDisplay;
  if (p.styleOpacity !== undefined) plain.opacity = p.styleOpacity;
  const hasPlain = Object.keys(plain).length > 0;
  if (!p.styleThrows) return hasPlain ? plain : undefined;
  return hasPlain ? [plain, throwsOnRead()] : throwsOnRead();
}

function namedComponent(name: string): any {
  const fn = function () {};
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

function makeFiber(n: FixtureNode, fabric: boolean): any {
  const p = n.props;
  const props: Record<string, unknown> = {};
  if (p.testID !== undefined) props.testID = p.testID;
  if (p.placeholder !== undefined) props.placeholder = p.placeholder;
  if (p.accessibilityLabel !== undefined) props.accessibilityLabel = p.accessibilityLabel;
  if (p.accessibilityRole !== undefined) props.accessibilityRole = p.accessibilityRole;
  if (p.accessibilityElementsHidden !== undefined) props.accessibilityElementsHidden = p.accessibilityElementsHidden;
  if (p.ariaHidden !== undefined) props["aria-hidden"] = p.ariaHidden;
  if (p.importantForAccessibility !== undefined) props.importantForAccessibility = p.importantForAccessibility;
  if (p.activityState !== undefined) props.activityState = p.activityState;
  if (p.focused !== undefined) props.focused = p.focused;
  if (p.index !== undefined) props.index = p.index;
  if (p.navigationIndex !== undefined) props.navigationState = { index: p.navigationIndex };
  if (p.display !== undefined) props.display = p.display;
  if (p.childrenText !== undefined) props.children = p.childrenText;
  // An own `value` of undefined is a real shape: it is what an uncontrolled
  // input reads back, and hasOwnProperty must still see it.
  if (p.hasValue) props.value = p.value;
  for (const h of ["onPress", "onLongPress", "onClick", "onChangeText", "onStartShouldSetResponder"] as const) {
    if (p[h]) props[h] = () => {};
  }
  const style = styleFor(p);
  if (style !== undefined) props.style = style;

  return {
    // A host fiber's type is its native class name; a composite's is the
    // component function. Code that branches on `typeof type === "string"` must
    // see the same difference the app shows it.
    type: n.host ? n.name : namedComponent(n.name),
    memoizedProps: props,
    stateNode: n.rect
      ? fabric
        ? { node: { __rect: n.rect }, canonical: { nativeTag: n.i, publicInstance: null } }
        : {
            measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) =>
              setTimeout(() => cb(n.rect!.x, n.rect!.y, n.rect!.w, n.rect!.h), 1),
          }
      : null,
    child: null,
    sibling: null,
  };
}

/**
 * Rehydrates a recorded projection into a fiber tree of the same shape
 * `fiberTree.ts` builds by hand, so every expression that walks one walks the
 * other unchanged.
 */
export function fiberTreeFixture(name: string, opts?: { fabric?: boolean }): any {
  const fixture = readFixture<FiberFixture>(name);
  const fabric = opts?.fabric ?? fixture.meta.fabric !== false;
  const fibers = fixture.nodes.map((n) => makeFiber(n, fabric));

  // Document order is the child order; tracking the last child keeps this linear
  // instead of walking each sibling chain to its end.
  const lastChild: any[] = new Array(fibers.length).fill(null);
  const roots: any[] = [];
  for (let i = 0; i < fixture.nodes.length; i++) {
    const parent = fixture.nodes[i].parent;
    if (parent < 0) {
      roots.push(fibers[i]);
      continue;
    }
    if (lastChild[parent]) lastChild[parent].sibling = fibers[i];
    else fibers[parent].child = fibers[i];
    lastChild[parent] = fibers[i];
  }
  if (roots.length === 0) throw new Error(`${name} has no root node (parent: -1)`);
  // Several fiber roots become one sibling chain: the walkers iterate siblings
  // exactly as they iterate roots, so this is the same traversal.
  for (let i = 0; i < roots.length - 1; i++) roots[i].sibling = roots[i + 1];
  return linkParents(roots[0]);
}
