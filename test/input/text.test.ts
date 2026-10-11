import { describe, it, expect } from "vitest";
import { listInputsExpression, typeExpression, readInputExpression } from "../../src/input/text.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { linkParents, paperFiber, fabricFiber, hookGlobals, type NodeSpec, type Rect } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";

const SCREEN: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } };
const FIELD: Rect = { x: 16, y: 60, w: 320, h: 40 };

/**
 * The chain a single <TextInput> actually renders, measured on the live app:
 * CssInterop.TextInput -> TextInput -> InternalTextInput -> RCTSinglelineTextInputView,
 * every level carrying the same props object. All four display names contain
 * "TextInput", so a naive walk reports one field four times.
 */
function inputChain(props: Record<string, unknown>, rect: Rect = FIELD): NodeSpec {
  return {
    type: "CssInterop.TextInput",
    props,
    children: [
      {
        type: "TextInput",
        props,
        children: [
          {
            type: "InternalTextInput",
            props,
            children: [{ type: "RCTSinglelineTextInputView", props, rect }],
          },
        ],
      },
    ],
  };
}

/**
 * A native-stack scene: react-native-screens keeps every pushed screen mounted
 * and only activityState (0 detached, 1 below the top, 2 on top) says which one
 * the user is looking at.
 */
function nativeScreen(activityState: number, children: NodeSpec[]): NodeSpec {
  return { type: "RNSScreen", props: { activityState }, children };
}

function stack(...screens: NodeSpec[]): NodeSpec {
  return { type: "RNSScreenStack", props: {}, children: screens };
}

const LOWER: Rect = { x: 16, y: 600, w: 320, h: 40 };

async function run(expr: string, root: any, opts?: { fabric?: boolean }): Promise<any> {
  const fabric = opts?.fabric ?? true;
  const runtime = makeRuntime(hookGlobals(linkParents(root), { fabric }));
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(expr));
}

describe("listInputsExpression", () => {
  it("reports one input for the four-fiber chain a single TextInput renders", async () => {
    const props = { placeholder: "Search", value: "cat", onChangeText: () => {} };
    // A user-land wrapper whose own name contains "TextInput" but which carries
    // none of the input props must not be mistaken for the field itself.
    const root = fabricFiber({
      ...SCREEN,
      children: [{ type: "SearchTextInputRow", props: { style: {} }, children: [inputChain(props)] }],
    });
    // In a real app the outermost level is a component, not a string: its name
    // lives on type.displayName.
    root.child.child.type = { displayName: "CssInterop.TextInput" };

    const out = await run(listInputsExpression(), root);
    expect(out.available).toBe(true);
    expect(out.inputs).toHaveLength(1);
    expect(out.inputs[0]).toMatchObject({
      placeholder: "Search",
      value: "cat",
      controlled: true,
      x: 16,
      y: 60,
      w: 320,
      h: 40,
    });
  });

  it("marks an input with no value prop as uncontrolled", async () => {
    const props = { placeholder: "Your name", onChangeText: () => {} };
    const out = await run(listInputsExpression(), fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out.inputs).toHaveLength(1);
    expect(out.inputs[0].controlled).toBe(false);
    expect(out.inputs[0].value).toBeUndefined();
  });

  it("survives a props getter that throws (Reanimated)", async () => {
    const props = {
      placeholder: "Search",
      value: "cat",
      onChangeText: () => {},
      // accessibilityLabel is read on every input; an animated prop throws on access
      // and an unguarded read would abort the whole capture.
      get accessibilityLabel(): string {
        throw new Error("[Reanimated] Trying to read an animated value");
      },
      get style(): unknown {
        throw new Error("[Reanimated] Trying to read an animated style");
      },
    };
    const out = await run(listInputsExpression(), fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out.available).toBe(true);
    expect(out.inputs).toHaveLength(1);
    expect(out.inputs[0]).toMatchObject({ placeholder: "Search", controlled: true });
    expect(out.inputs[0].label).toBeUndefined();
  });
});

describe("typeExpression", () => {
  it("types into the only input on screen when `into` is omitted", async () => {
    let got: string | undefined;
    const props = { placeholder: "Search", value: "", onChangeText: (v: string) => { got = v; } };
    const out = await run(typeExpression(null, "cat"), fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out.typed).toBe(true);
    expect(out.matched).toMatchObject({ placeholder: "Search" });
    expect(got).toBe("cat");
  });

  it("refuses and names the candidates when two inputs are mounted", async () => {
    const search = { placeholder: "Search", value: "", onChangeText: () => {} };
    const email = { testID: "email-field", value: "", onChangeText: () => {} };
    const out = await run(
      typeExpression(null, "cat"),
      fabricFiber({
        ...SCREEN,
        children: [inputChain(search), inputChain(email, { x: 16, y: 120, w: 320, h: 40 })],
      }),
    );
    expect(out.typed).toBe(false);
    expect(out.reason).toContain("2 text inputs on screen");
    expect(out.reason).toContain('placeholder "Search"');
    expect(out.reason).toContain('testID "email-field"');
  });

  it("matches by placeholder when the field has no testID", async () => {
    // The live app's search field: placeholder "Search", no testID at all.
    let got: string | undefined;
    const search = { placeholder: "Search", value: "", onChangeText: (v: string) => { got = v; } };
    const email = { testID: "email-field", value: "", onChangeText: () => {} };
    const out = await run(
      typeExpression({ placeholder: "Search" }, "cat"),
      fabricFiber({
        ...SCREEN,
        children: [inputChain(search), inputChain(email, { x: 16, y: 120, w: 320, h: 40 })],
      }),
    );
    expect(out.typed).toBe(true);
    expect(out.matched).toMatchObject({ placeholder: "Search" });
    expect(got).toBe("cat");
  });

  it("matches by testID when both fields share a placeholder", async () => {
    let a: string | undefined;
    let b: string | undefined;
    const first = { testID: "row-a", placeholder: "Amount", value: "", onChangeText: (v: string) => { a = v; } };
    const second = { testID: "row-b", placeholder: "Amount", value: "", onChangeText: (v: string) => { b = v; } };
    const out = await run(
      typeExpression({ testID: "row-b", placeholder: "Amount" }, "12"),
      fabricFiber({
        ...SCREEN,
        children: [inputChain(first), inputChain(second, { x: 16, y: 120, w: 320, h: 40 })],
      }),
    );
    expect(out.typed).toBe(true);
    expect(out.matched).toMatchObject({ testID: "row-b" });
    expect(a).toBeUndefined();
    expect(b).toBe("12");
  });

  it("refuses an uncontrolled input, because onChangeText cannot drive it", async () => {
    const props = { placeholder: "Search", onChangeText: () => {} };
    const out = await run(typeExpression(null, "cat"), fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out.typed).toBe(false);
    expect(out.reason).toBe("uncontrolled input — no value prop to drive");
    expect(out.matched).toMatchObject({ placeholder: "Search", controlled: false });
  });
});

describe("readInputExpression", () => {
  it("reads the value back (Paper, where measurement is asynchronous)", async () => {
    const props = { placeholder: "Search", value: "cat", onChangeText: () => {} };
    const out = await run(
      readInputExpression({ placeholder: "Search" }),
      paperFiber({ ...SCREEN, children: [inputChain(props)] }),
      { fabric: false },
    );
    expect(out).toEqual({ found: true, value: "cat" });
  });
});

/**
 * Field test: a stack with the same screen pushed twice (Post -> Post, or a chat
 * composer reopened) leaves two TextInputs with identical testID and placeholder
 * mounted. Both measure normally — the one underneath keeps a valid frame — so
 * only the scene each one sits in can say which field the user is looking at.
 */
describe("scene-aware targeting", () => {
  const field = (sink: (v: string) => void) => ({
    placeholder: "Message",
    value: "",
    onChangeText: sink,
  });

  it("types into the field on the screen on top of the stack", async () => {
    let under: string | undefined;
    let top: string | undefined;
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(1, [inputChain(field((v) => (under = v)))]),
          nativeScreen(2, [inputChain(field((v) => (top = v)), LOWER)]),
        ),
      ],
    });
    const out = await run(typeExpression({ placeholder: "Message" }, "hi"), root);
    expect(out.typed).toBe(true);
    expect(top).toBe("hi");
    expect(under).toBeUndefined();
    expect(out.matched).toMatchObject({ y: 600, scene: { focused: true, depth: 0 } });
    expect(out.note).toContain("focused screen");
  });

  it("reads back the same field it typed into, so verification is not fooled", async () => {
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(1, [inputChain({ placeholder: "Message", value: "stale", onChangeText: () => {} })]),
          nativeScreen(2, [inputChain({ placeholder: "Message", value: "fresh", onChangeText: () => {} }, LOWER)]),
        ),
      ],
    });
    const out = await run(readInputExpression({ placeholder: "Message" }), root);
    expect(out).toMatchObject({ found: true, value: "fresh" });
  });

  it("still refuses when both matches sit on the focused screen, naming their scene", async () => {
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(2, [
            inputChain(field(() => {})),
            inputChain(field(() => {}), LOWER),
          ]),
        ),
      ],
    });
    const out = await run(typeExpression({ placeholder: "Message" }, "hi"), root);
    expect(out.typed).toBe(false);
    expect(out.reason).toContain("2 text inputs matched");
    expect(out.reason).toContain("focused screen");
  });

  it("prefers the focused scene of a react-navigation JS stack", async () => {
    let under: string | undefined;
    let top: string | undefined;
    const root = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "CardStack",
          children: [
            { type: "Card", props: { focused: false }, children: [inputChain(field((v) => (under = v)))] },
            { type: "Card", props: { focused: true }, children: [inputChain(field((v) => (top = v)), LOWER)] },
          ],
        },
      ],
    });
    const out = await run(typeExpression({ placeholder: "Message" }, "hi"), root);
    expect(out.typed).toBe(true);
    expect(top).toBe("hi");
    expect(under).toBeUndefined();
  });

  it("counts only the focused screen when `into` is omitted", async () => {
    let background: string | undefined;
    let got: string | undefined;
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(1, [inputChain({ placeholder: "Search", value: "", onChangeText: (v: string) => (background = v) })]),
          nativeScreen(2, [inputChain(field((v) => (got = v)), LOWER)]),
        ),
      ],
    });
    const out = await run(typeExpression(null, "hi"), root);
    expect(out.typed).toBe(true);
    expect(got).toBe("hi");
    expect(background).toBeUndefined();
    expect(out.note).toContain("focused screen");
  });

  it("types into a background field when nothing on the focused screen matches, and says so", async () => {
    let background: string | undefined;
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(1, [
            inputChain({ testID: "draft", placeholder: "Message", value: "", onChangeText: (v: string) => (background = v) }),
          ]),
          nativeScreen(2, [inputChain({ placeholder: "Search", value: "", onChangeText: () => {} }, LOWER)]),
        ),
      ],
    });
    const out = await run(typeExpression({ testID: "draft" }, "hi"), root);
    expect(out.typed).toBe(true);
    expect(background).toBe("hi");
    expect(out.note).toContain("background screen");
    expect(out.matched.scene).toEqual({ focused: false, depth: 1 });
  });

  it("reports each input's scene in the listing", async () => {
    const root = fabricFiber({
      ...SCREEN,
      children: [
        stack(
          nativeScreen(1, [inputChain({ testID: "old", value: "", onChangeText: () => {} })]),
          nativeScreen(2, [inputChain({ testID: "new", value: "", onChangeText: () => {} }, LOWER)]),
        ),
      ],
    });
    const out = await run(listInputsExpression(), root);
    const byId = Object.fromEntries(out.inputs.map((i: any) => [i.testID, i.scene]));
    expect(byId).toEqual({ old: { focused: false, depth: 1 }, new: { focused: true, depth: 0 } });
  });

  it("is ES5: the app runtime is Hermes with no transpiler in the path", () => {
    for (const expr of [listInputsExpression(), typeExpression({ testID: "a" }, "x"), readInputExpression(null)]) {
      expect(expr).not.toMatch(/=>/);
      expect(expr).not.toMatch(/\b(let|const)\s/);
    }
  });
});
