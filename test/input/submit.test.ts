import { describe, it, expect } from "vitest";
import { submitExpression, type SubmitResult } from "../../src/input/submit.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { linkParents, fabricFiber, hookGlobals, type NodeSpec, type Rect } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";

const SCREEN: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } };
const FIELD: Rect = { x: 16, y: 60, w: 320, h: 40 };

/**
 * The same four-fiber chain a single <TextInput> renders on a live app, as
 * text.test.ts documents it: every level carries the same props object, so a
 * naive walk reports one field four times.
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
 * Focus lives on the *instance*, not in props: RN's host component exposes
 * isFocused(), which is what TextInput.State.currentlyFocusedInput() compares
 * against. fabricFiber leaves publicInstance null, so the test supplies one.
 */
function setFocused(root: any, index: number, focused: boolean): void {
  const hosts: any[] = [];
  (function walk(f: any) {
    while (f) {
      if (f.type === "RCTSinglelineTextInputView") hosts.push(f);
      walk(f.child);
      f = f.sibling;
    }
  })(root);
  hosts[index].stateNode.canonical.publicInstance = { isFocused: () => focused };
}

async function submit(root: any, target: any = null): Promise<SubmitResult> {
  const runtime = makeRuntime(hookGlobals(linkParents(root), { fabric: true }));
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(submitExpression(target)));
}

describe("submitExpression", () => {
  it("fires onSubmitEditing, onEndEditing and onBlur with the field's current text", async () => {
    const events: [string, any][] = [];
    const props = {
      placeholder: "Search",
      value: "cat",
      onChangeText: () => {},
      onSubmitEditing: (e: any) => events.push(["onSubmitEditing", e]),
      onEndEditing: (e: any) => events.push(["onEndEditing", e]),
      onBlur: (e: any) => events.push(["onBlur", e]),
    };
    const out = await submit(fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out).toMatchObject({
      submitted: true,
      field: 'placeholder "Search"',
      handlers: ["onSubmitEditing", "onEndEditing", "onBlur"],
    });
    expect(events.map((e) => e[0])).toEqual(["onSubmitEditing", "onEndEditing", "onBlur"]);
    // The shape RN's own keyboard return key delivers — an app that reads
    // e.nativeEvent.text instead of its own state must still work.
    expect(events[0][1].nativeEvent.text).toBe("cat");
  });

  it("refuses when the field has no onSubmitEditing handler", async () => {
    const onEnd = [] as any[];
    const props = {
      testID: "search",
      value: "cat",
      onChangeText: () => {},
      onEndEditing: (e: any) => onEnd.push(e),
    };
    const out = await submit(fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out).toEqual({
      submitted: false,
      field: 'testID "search"',
      reason: "field has no onSubmitEditing handler",
    });
    // Nothing else fires either: a half-submit is harder to reason about than
    // a refusal that names what is missing.
    expect(onEnd).toEqual([]);
  });

  it("leaves the field focused when blurOnSubmit is false", async () => {
    const fired: string[] = [];
    const props = {
      placeholder: "Message",
      value: "hi",
      blurOnSubmit: false,
      onSubmitEditing: () => fired.push("onSubmitEditing"),
      onBlur: () => fired.push("onBlur"),
    };
    const out = await submit(fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect((out as any).handlers).toEqual(["onSubmitEditing"]);
    expect(fired).toEqual(["onSubmitEditing"]);
  });

  it("picks the focused input when several are on screen and no target is given", async () => {
    const fired: string[] = [];
    const a = { placeholder: "Email", value: "a@b.c", onSubmitEditing: () => fired.push("email") };
    const b = { placeholder: "Password", value: "pw", onSubmitEditing: () => fired.push("password") };
    const root = fabricFiber({
      ...SCREEN,
      children: [inputChain(a), inputChain(b, { x: 16, y: 120, w: 320, h: 40 })],
    });
    setFocused(root, 1, true);
    const out = await submit(root);
    expect(out).toMatchObject({ submitted: true, field: 'placeholder "Password"' });
    expect(fired).toEqual(["password"]);
  });

  it("asks for a target when several are on screen and none is focused", async () => {
    const a = { placeholder: "Email", value: "", onSubmitEditing: () => {} };
    const b = { placeholder: "Password", value: "", onSubmitEditing: () => {} };
    const out = await submit(
      fabricFiber({ ...SCREEN, children: [inputChain(a), inputChain(b, { x: 16, y: 120, w: 320, h: 40 })] }),
    );
    expect(out.submitted).toBe(false);
    expect((out as any).reason).toMatch(/2 text inputs on screen/);
    expect((out as any).reason).toMatch(/Email/);
  });

  it("selects a field by testID even when another one holds focus", async () => {
    const fired: string[] = [];
    const a = { testID: "email", value: "a@b.c", onSubmitEditing: () => fired.push("email") };
    const b = { testID: "password", value: "pw", onSubmitEditing: () => fired.push("password") };
    const root = fabricFiber({
      ...SCREEN,
      children: [inputChain(a), inputChain(b, { x: 16, y: 120, w: 320, h: 40 })],
    });
    setFocused(root, 1, true);
    const out = await submit(root, { testID: "email" });
    expect(fired).toEqual(["email"]);
    expect(out).toMatchObject({ field: 'testID "email"' });
  });

  it("reports the app's own exception instead of claiming the submit landed", async () => {
    const props = {
      placeholder: "Search",
      value: "cat",
      onSubmitEditing: () => {
        throw new Error("boom");
      },
    };
    const out = await submit(fabricFiber({ ...SCREEN, children: [inputChain(props)] }));
    expect(out.submitted).toBe(false);
    expect((out as any).reason).toMatch(/onSubmitEditing threw: .*boom/);
  });

  it("says so when no text input is mounted", async () => {
    const out = await submit(fabricFiber(SCREEN));
    expect(out.submitted).toBe(false);
    expect((out as any).reason).toMatch(/no text input is mounted/);
  });

  it("is ES5 — Hermes evaluates this as written, with no transpile step", () => {
    const src = submitExpression({ testID: "search" });
    expect(src).not.toMatch(/=>/);
    expect(src).not.toMatch(/\b(let|const)\s/);
    // A backtick inside a double-quoted string is fine ES5 — what must never
    // survive is an uninterpolated placeholder.
    expect(src).not.toMatch(/\$\{/);
  });
});
