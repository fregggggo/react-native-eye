/**
 * Fake React fiber trees for expressions that are evaluated inside a runtime
 * fake (`makeRuntime`) rather than string-matched. Shared by the layout, press,
 * text and scroll expression tests so that all four are exercised against the
 * same shapes.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type NodeSpec = { type: string; props?: Record<string, unknown>; rect?: Rect; children?: NodeSpec[] };

/** Links parents so the hit-test branch walk (fiber.return) has something to follow. */
export function linkParents(fiber: any, parent: any = null): any {
  if (!fiber) return fiber;
  fiber.return = parent;
  linkParents(fiber.child, fiber);
  linkParents(fiber.sibling, parent);
  return fiber;
}

/** Paper: the host instance itself measures, asynchronously. */
export function paperFiber(spec: NodeSpec, siblings: NodeSpec[] = [], i = 0): any {
  const rest = siblings.slice(i + 1);
  return {
    type: spec.type,
    memoizedProps: spec.props ?? {},
    stateNode: spec.rect
      ? {
          measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) =>
            setTimeout(() => cb(spec.rect!.x, spec.rect!.y, spec.rect!.w, spec.rect!.h), 1),
        }
      : null,
    child: spec.children?.length ? paperFiber(spec.children[0], spec.children, 0) : null,
    sibling: rest.length ? paperFiber(rest[0], rest, 0) : null,
  };
}

/** Fabric: stateNode is {node, canonical}; measurement goes through nativeFabricUIManager. */
export function fabricFiber(spec: NodeSpec, siblings: NodeSpec[] = [], i = 0): any {
  const rest = siblings.slice(i + 1);
  return {
    type: spec.type,
    memoizedProps: spec.props ?? {},
    stateNode: spec.rect
      ? { node: { __rect: spec.rect }, canonical: { nativeTag: 1, publicInstance: null } }
      : null,
    child: spec.children?.length ? fabricFiber(spec.children[0], spec.children, 0) : null,
    sibling: rest.length ? fabricFiber(rest[0], rest, 0) : null,
  };
}

/**
 * The globals an injected expression looks for: the DevTools hook exposing one
 * renderer with `root` as its only fiber root, plus — on Fabric — the UI manager
 * that measures `stateNode.node`. Pass the result straight to `makeRuntime`.
 */
export function hookGlobals(root: any, opts?: { fabric?: boolean }): Record<string, unknown> {
  return {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: root }]),
    },
    ...(opts?.fabric
      ? {
          nativeFabricUIManager: {
            // The real one calls back synchronously — the whole capture is then
            // a single round trip.
            measureInWindow: (node: any, cb: (x: number, y: number, w: number, h: number) => void) =>
              cb(node.__rect.x, node.__rect.y, node.__rect.w, node.__rect.h),
          },
        }
      : {}),
  };
}
