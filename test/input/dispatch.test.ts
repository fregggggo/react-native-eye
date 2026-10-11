import { describe, it, expect, beforeEach } from "vitest";
import {
  dispatchTap,
  dispatchType,
  dispatchSwipe,
  dispatchBack,
  dispatchSubmit,
  osMarker,
} from "../../src/input/dispatch.js";
import { resetHotState, hotNotice, recordTouch } from "../../src/input/hotState.js";
import { UserInputError } from "../../src/core/errors.js";
import type { DeviceDriver, OsPath } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";
import { tapInternal } from "../../src/tools/interact.js";

/** Records taps and serves a scripted sequence of OS layouts. */
function fakeDriver(layouts: any[][] = [[]]) {
  const taps: { x: number; y: number; durationMs?: number }[] = [];
  let n = 0;
  const driver = {
    platform: "ios" as const,
    listDevices: async () => [{ platform: "ios" as const, udid: "U", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () => axeLayout(layouts[Math.min(n++, layouts.length - 1)]),
    tapXY: async (_u: string, x: number, y: number, durationMs?: number) => {
      taps.push({ x, y, durationMs });
      return AXE;
    },
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
  } as unknown as DeviceDriver;
  return { driver, taps };
}

/** The real Connection returns the expression's value; press.ts returns JSON. */
function fakeConn(result: unknown) {
  const exprs: string[] = [];
  const conn = {
    evaluate: async (expr: string) => {
      exprs.push(expr);
      return JSON.stringify(result);
    },
  };
  return { conn, exprs };
}

const PRESSED = { pressed: true, component: "Pressable", handler: "onPress", depth: 3 };

describe("dispatchTap: auto", () => {
  beforeEach(() => resetHotState());

  it("presses through JS and never touches the driver", async () => {
    const { driver, taps } = fakeDriver();
    const { conn } = fakeConn(PRESSED);
    const d = await dispatchTap({ driver, udid: "U", x: 10, y: 20, via: "auto", conn });
    expect(taps).toEqual([]);
    expect(d.marker).toBe("(input: js)");
  });

  it("falls back to the driver and names why the press found no handler", async () => {
    const { driver, taps } = fakeDriver();
    const { conn } = fakeConn({ pressed: false, reason: "no press handler in ancestry" });
    const d = await dispatchTap({ driver, udid: "U", x: 10, y: 20, via: "auto", conn });
    expect(taps).toEqual([{ x: 10, y: 20, durationMs: undefined }]);
    expect(d.marker).toBe("(input: os/axe — no press handler in ancestry)");
  });

  it("falls back with a named reason when there is no connection at all", async () => {
    const { driver, taps } = fakeDriver();
    const d = await dispatchTap({ driver, udid: "U", x: 1, y: 2, via: "auto" });
    expect(taps.length).toBe(1);
    expect(d.marker).toContain("no Metro connection");
  });

  it("falls back with the thrown message when the expression throws", async () => {
    const { driver, taps } = fakeDriver();
    const conn = {
      evaluate: async () => {
        throw new Error("__REACT_DEVTOOLS_GLOBAL_HOOK__ missing");
      },
    };
    const d = await dispatchTap({ driver, udid: "U", x: 1, y: 2, via: "auto", conn });
    expect(taps.length).toBe(1);
    expect(d.marker).toBe("(input: os/axe — __REACT_DEVTOOLS_GLOBAL_HOOK__ missing)");
  });
});

describe("dispatchTap: explicit via", () => {
  beforeEach(() => resetHotState());

  it("via: os never evaluates the expression, even with a working connection", async () => {
    const { driver, taps } = fakeDriver();
    const { conn, exprs } = fakeConn(PRESSED);
    const d = await dispatchTap({ driver, udid: "U", x: 10, y: 20, via: "os", conn });
    expect(exprs).toEqual([]);
    expect(taps.length).toBe(1);
    expect(d.marker).toBe("(input: os/axe)");
  });

  it("via: js refuses instead of falling back when there is no connection", async () => {
    const { driver, taps } = fakeDriver();
    await expect(dispatchTap({ driver, udid: "U", x: 1, y: 2, via: "js" })).rejects.toThrow(
      /no active Metro connection/,
    );
    expect(taps).toEqual([]);
  });

  it("via: js refuses instead of falling back when the press fails", async () => {
    const { driver, taps } = fakeDriver();
    const { conn } = fakeConn({ pressed: false, reason: "no press handler in ancestry" });
    await expect(
      dispatchTap({ driver, udid: "U", x: 1, y: 2, via: "js", conn }),
    ).rejects.toThrow(UserInputError);
    await expect(
      dispatchTap({ driver, udid: "U", x: 1, y: 2, via: "js", conn }),
    ).rejects.toThrow(/no press handler in ancestry/);
    expect(taps).toEqual([]);
  });
});

describe("dispatchTap: press shape and hot state", () => {
  beforeEach(() => resetHotState());

  it("asks for a long press when duration_ms reaches the long-press threshold", async () => {
    // pressExpression embeds the flag as `WANT_LONG = true/false`, not a
    // literal "longPress" substring — "onLongPress" (capital L) is emitted
    // unconditionally as a handler-name literal regardless of this flag.
    const { driver } = fakeDriver();
    const { conn, exprs } = fakeConn(PRESSED);
    await dispatchTap({ driver, udid: "U", x: 1, y: 2, durationMs: 800, via: "auto", conn });
    expect(exprs[0]).toContain("WANT_LONG = true");
  });

  it("uses a plain press below the threshold", async () => {
    const { driver } = fakeDriver();
    const { conn, exprs } = fakeConn(PRESSED);
    await dispatchTap({ driver, udid: "U", x: 1, y: 2, durationMs: 120, via: "auto", conn });
    expect(exprs[0]).toContain("WANT_LONG = false");
  });

  it("does not record a JS press as a touch (it would poison the hot-state signal)", async () => {
    const { driver } = fakeDriver();
    const { conn } = fakeConn(PRESSED);
    const slow = {
      ...driver,
      tapXY: async () => {
        throw new Error("driver must not be called");
      },
    } as unknown as DeviceDriver;
    const d = await dispatchTap({ driver: slow, udid: "U", x: 1, y: 2, via: "auto", conn });
    expect(d.note).toBeUndefined();
    expect(hotNotice("U")).toBeUndefined();
  });

  it("does not surface a stale slow-touch note on a JS-success return, but does on the OS path with the same seeded state", async () => {
    // A note about degraded *touch* delivery attached to "(input: js)" would be
    // self-contradicting (no touch happened) and would burn the one-time
    // announcement on the response where the advice is useless. The moment
    // auto falls back to OS, the same seeded state must surface it.
    recordTouch("U", 20000);
    const { driver: jsDriver } = fakeDriver();
    const { conn: jsConn } = fakeConn(PRESSED);
    const jsResult = await dispatchTap({ driver: jsDriver, udid: "U", x: 1, y: 2, via: "auto", conn: jsConn });
    expect(jsResult.marker).toBe("(input: js)");
    expect(jsResult.note).toBeUndefined();

    const { driver: osDriver } = fakeDriver();
    const osResult = await dispatchTap({ driver: osDriver, udid: "U", x: 1, y: 2, via: "os" });
    expect(osResult.marker).toBe("(input: os/axe)");
    expect(osResult.note).toMatch(/touch delivery/);
  });
});

describe("tapInternal marker", () => {
  beforeEach(() => resetHotState());

  const login = [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }];
  const welcome = [{ text: "Welcome", x: 0, y: 0, w: 100, h: 40 }];

  it("ends the head line with the marker and keeps the layout diff", async () => {
    // The marker terminates the "Tapped …" line; the diff keeps its own lines
    // below it, exactly as before this task.
    const { driver, taps } = fakeDriver([login, welcome]);
    const { conn } = fakeConn(PRESSED);
    const out = await tapInternal(driver, "U", { text: "Login" }, undefined, conn);
    expect(taps).toEqual([]);
    expect(out.split("\n")[0]).toBe('Tapped "Login" @50,20. (input: js)');
    expect(out).toContain("- Login");
    expect(out).toContain("+ Welcome");
  });

  it("names the OS path and its reason when via is os", async () => {
    const { driver, taps } = fakeDriver([login, welcome]);
    const { conn } = fakeConn(PRESSED);
    const out = await tapInternal(driver, "U", { text: "Login" }, undefined, conn, "os");
    expect(taps).toEqual([{ x: 50, y: 20, durationMs: undefined }]);
    expect(out.split("\n")[0]).toBe('Tapped "Login" @50,20. (input: os/axe)');
  });

  it("appends the degraded-touch notice on its own line", async () => {
    const { driver } = fakeDriver([login, welcome]);
    const slow = {
      ...driver,
      tapXY: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return AXE;
      },
    } as unknown as DeviceDriver;
    // Force the slow-touch record rather than waiting out a real 5s touch.
    recordTouch("U", 19000);
    const out = await tapInternal(slow, "U", { text: "Login" }, undefined, undefined, "os");
    expect(out).toContain("(input: os/axe)");
    expect(out.split("\n").some((l) => l.startsWith("Note: touch delivery"))).toBe(true);
  });
});

describe("dispatchType", () => {
  /**
   * A stand-in for the app runtime that answers whichever expression it is handed.
   * The expressions identify themselves with a leading marker comment, so this
   * needs no fiber tree — the tree is exercised in test/input/text.test.ts.
   */
  function fakeConn(replies: { type?: unknown; read?: unknown[] }) {
    const seen: string[] = [];
    let reads = 0;
    return {
      seen,
      evaluate: async (expr: string) => {
        if (expr.indexOf("/* rne:type */") === 0) {
          seen.push("type");
          return JSON.stringify(replies.type);
        }
        seen.push("read");
        const list = replies.read ?? [];
        return JSON.stringify(list[Math.min(reads++, list.length - 1)]);
      },
    };
  }

  function fakeDriver() {
    const typed: string[] = [];
    return {
      typed,
      driver: {
        platform: "ios" as const,
        typeText: async (_udid: string, t: string) => { typed.push(t); return AXE; },
      } as any,
    };
  }

  it("carries the app's own note about which field it chose", async () => {
    // text.ts disambiguates a selector that matched more than one field and
    // says which one it picked. Dropping that turns a value typed onto a
    // background screen into a silent success.
    const { driver } = fakeDriver();
    const conn = fakeConn({
      type: {
        typed: true,
        matched: { placeholder: "Message", controlled: true },
        note: '2 matched "Message"; chose the one on the focused screen',
      },
      read: [{ found: true, value: "hi" }],
    });
    const out = await dispatchType({ driver, udid: "U", value: "hi", via: "auto", conn: conn as any, verify: true });
    expect(out.marker).toBe("(input: js)");
    expect(out.note).toBe('2 matched "Message"; chose the one on the focused screen');
  });

  it("fails loudly when the field does not read back what was sent", async () => {
    // Measured: "cat" through axe type arrived as "сф" under a Russian host
    // keyboard layout, and today that returns as success.
    const { driver } = fakeDriver();
    const conn = fakeConn({
      type: { typed: true, matched: { placeholder: "Search", controlled: true } },
      read: [{ found: true, value: "сф" }],
    });
    await expect(
      dispatchType({ driver, udid: "U", value: "cat", via: "auto", conn: conn as any, verify: true }),
    ).rejects.toThrow(/Typed "cat" but the field now reads "сф" — the text was corrupted in transit\./);
  });

  it("succeeds and names the JS path when the read-back matches", async () => {
    const { typed, driver } = fakeDriver();
    const conn = fakeConn({
      type: { typed: true, matched: { placeholder: "Search", controlled: true } },
      read: [{ found: true, value: "cat" }],
    });
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "auto", conn: conn as any, verify: true });
    expect(out.marker).toBe("(input: js)");
    expect(out.note).toBeUndefined();
    expect(typed).toEqual([]); // the OS keyboard was never touched
    expect(conn.seen).toEqual(["type", "read"]);
  });

  it("verifies the OS path too — that is the path that corrupts", async () => {
    const { typed, driver } = fakeDriver();
    const conn = fakeConn({ read: [{ found: true, value: "сф" }] });
    await expect(
      dispatchType({ driver, udid: "U", value: "cat", via: "os", conn: conn as any, verify: true }),
    ).rejects.toThrow(/corrupted in transit/);
    expect(typed).toEqual(["cat"]);
    expect(conn.seen).toEqual(["read"]); // no JS typing was attempted
  });

  it("accepts an OS read-back that appended to text already in the field", async () => {
    const { driver } = fakeDriver();
    const conn = fakeConn({ read: [{ found: true, value: "dogcat" }] });
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "os", conn: conn as any, verify: true });
    expect(out.marker).toBe("(input: os/axe)");
    expect(out.note).toMatch(/appended/);
  });

  it("falls back to the OS keyboard with the reason in the marker", async () => {
    const { typed, driver } = fakeDriver();
    const conn = fakeConn({
      type: { typed: false, reason: "uncontrolled input — no value prop to drive" },
      read: [{ found: false, reason: "uncontrolled input — no value prop to read" }],
    });
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "auto", conn: conn as any, verify: true });
    expect(out.marker).toBe("(input: os/axe — uncontrolled input — no value prop to drive)");
    expect(typed).toEqual(["cat"]);
    expect(out.note).toMatch(/Not verified: uncontrolled input/);
  });

  it("falls back to the OS keyboard when the JS evaluate call itself throws", async () => {
    // Mirrors dispatchTap's "falls back with the thrown message when the
    // expression throws": a CDP timeout or dropped connection during typing
    // must degrade auto to the OS keyboard, not propagate as a bare failure.
    const { typed, driver } = fakeDriver();
    const seen: string[] = [];
    const conn = {
      evaluate: async (expr: string) => {
        if (expr.indexOf("/* rne:type */") === 0) {
          seen.push("type");
          throw new Error("socket hang up");
        }
        seen.push("read");
        return JSON.stringify({ found: true, value: "cat" });
      },
    };
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "auto", conn: conn as any, verify: true });
    expect(out.marker).toBe("(input: os/axe — socket hang up)");
    expect(typed).toEqual(["cat"]);
    expect(seen).toEqual(["type", "read"]);
  });

  it("via: js surfaces the raw thrown error instead of falling back", async () => {
    const { typed, driver } = fakeDriver();
    const conn = {
      evaluate: async (expr: string) => {
        if (expr.indexOf("/* rne:type */") === 0) throw new Error("socket hang up");
        return JSON.stringify({ found: true, value: "cat" });
      },
    };
    await expect(
      dispatchType({ driver, udid: "U", value: "cat", via: "js", conn: conn as any, verify: true }),
    ).rejects.toThrow(/socket hang up/);
    expect(typed).toEqual([]);
  });

  it("via: js refuses with UserInputError (not DriverError) when the app itself refuses", async () => {
    // DriverError renders as "Driver error: ..."; an app-level refusal like an
    // uncontrolled input or an ambiguous target is not a driver failure.
    const { typed, driver } = fakeDriver();
    const conn = fakeConn({ type: { typed: false, reason: "uncontrolled input — no value prop to drive" } });
    const err: unknown = await dispatchType({
      driver,
      udid: "U",
      value: "cat",
      via: "js",
      conn: conn as any,
      verify: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UserInputError);
    expect((err as Error).message).toContain("uncontrolled input — no value prop to drive");
    expect(typed).toEqual([]);
  });

  it("refuses via: os with an into target instead of typing into whatever has focus", async () => {
    // axe type sends HID key events to whatever currently holds focus, not to
    // the resolved target — typing blind here would silently ignore `into`.
    const { typed, driver } = fakeDriver();
    const err: unknown = await dispatchType({
      driver,
      udid: "U",
      value: "cat",
      into: { placeholder: "Search" },
      via: "os",
      verify: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UserInputError);
    expect((err as Error).message).toContain("cannot target a specific field on the OS path");
    expect((err as Error).message).toMatch(/Tap the field first/);
    expect((err as Error).message).toMatch(/via: "js"/);
    expect(typed).toEqual([]);
  });

  it("refuses instead of a blind driver.typeText when auto's JS path fails and into was specified", async () => {
    const { typed, driver } = fakeDriver();
    const conn = fakeConn({ type: { typed: false, reason: "uncontrolled input — no value prop to drive" } });
    const err: unknown = await dispatchType({
      driver,
      udid: "U",
      value: "cat",
      into: { placeholder: "Search" },
      via: "auto",
      conn: conn as any,
      verify: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UserInputError);
    expect((err as Error).message).toContain("cannot target a specific field on the OS path");
    expect(typed).toEqual([]); // no blind driver.typeText call
  });

  it("still types via os with no into target, unchanged", async () => {
    // Regression guard: the refusal above must not over-correct into refusing
    // the plain, targetless OS path, which is the documented honest behaviour
    // of type_text without a target.
    const { typed, driver } = fakeDriver();
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "os", verify: false });
    expect(out.marker).toBe("(input: os/axe)");
    expect(typed).toEqual(["cat"]);
  });
});

/** Records swipes and back-presses; nothing else on the driver is exercised. */
function gestureDriver() {
  const swipes: number[][] = [];
  const keys: string[] = [];
  const driver = {
    platform: "ios" as const,
    swipe: async (_u: string, x1: number, y1: number, x2: number, y2: number, ms?: number) => {
      swipes.push([x1, y1, x2, y2, ms ?? 0]);
      return AXE;
    },
    pressKey: async (_u: string, key: string) => {
      keys.push(key);
      return AXE;
    },
    pointScale: async () => 1,
  } as unknown as DeviceDriver;
  return { driver, swipes, keys };
}

describe("dispatchSwipe", () => {
  beforeEach(() => resetHotState());

  it("scrolls the container under the start point and never touches the driver", async () => {
    const { driver, swipes } = gestureDriver();
    const { conn, exprs } = fakeConn({
      scrolled: true,
      container: "FlatList",
      method: "scrollToOffset",
      from: 0,
      to: 640,
    });
    const d = await dispatchSwipe({
      driver,
      udid: "U",
      coords: [200, 600, 200, 200],
      via: "auto",
      conn: conn as any,
    });
    expect(swipes).toEqual([]);
    expect(d.marker).toBe("(input: js)");
    expect(d.js).toEqual({ container: "FlatList", method: "scrollToOffset", from: 0, to: 640 });
    // A finger travelling 400pt up drags the content 400pt up — the offset
    // rises by the same amount, which is what the OS swipe would have done.
    expect(exprs[0]).toContain("DY = 400");
    expect(exprs[0]).toContain("TY = 600");
  });

  it("falls back to the OS swipe and names the reason in the marker", async () => {
    const { driver, swipes } = gestureDriver();
    const { conn } = fakeConn({ scrolled: false, reason: "no scroll container under 200,400" });
    const d = await dispatchSwipe({
      driver,
      udid: "U",
      coords: [200, 400, 200, 100],
      durationMs: 300,
      via: "auto",
      conn: conn as any,
    });
    expect(swipes).toEqual([[200, 400, 200, 100, 300]]);
    expect(d.marker).toBe("(input: os/axe — no scroll container under 200,400)");
    expect(d.js).toBeUndefined();
  });

  it("via: os never evaluates the expression", async () => {
    const { driver, swipes } = gestureDriver();
    const { conn, exprs } = fakeConn({ scrolled: true, container: "FlatList", method: "scrollToOffset", from: 0, to: 1 });
    const d = await dispatchSwipe({ driver, udid: "U", coords: [1, 2, 3, 4], via: "os", conn: conn as any });
    expect(exprs).toEqual([]);
    expect(swipes).toHaveLength(1);
    expect(d.marker).toBe("(input: os/axe)");
  });

  it("via: js refuses instead of degrading into a 20s touch", async () => {
    const { driver, swipes } = gestureDriver();
    const { conn } = fakeConn({ scrolled: false, reason: "no scroll container under 200,400" });
    await expect(
      dispatchSwipe({ driver, udid: "U", coords: [200, 400, 200, 100], via: "js", conn: conn as any }),
    ).rejects.toThrow(/no scroll container under 200,400/);
    expect(swipes).toEqual([]);
  });

  it("scales the point and the delta into the app's own units", async () => {
    // Android reports layout in pixels but the app measures in dp; the
    // expression hit-tests in app units, exactly as scrollToInternal does.
    const { driver } = gestureDriver();
    const { conn, exprs } = fakeConn({ scrolled: true, container: "ScrollView", method: "scrollTo", from: 0, to: 100 });
    await dispatchSwipe({
      driver,
      udid: "U",
      coords: [540, 1200, 540, 600],
      via: "js",
      conn: conn as any,
      space: { scale: 3, x: 0, y: 0 },
    });
    expect(exprs[0]).toContain("TX = 180");
    expect(exprs[0]).toContain("DY = 200");
  });
});

describe("dispatchBack", () => {
  beforeEach(() => resetHotState());

  it("goes back through the navigation ref without a touch", async () => {
    const { driver, keys } = gestureDriver();
    const { conn } = fakeConn({ went: true, source: "fiber" });
    const d = await dispatchBack({ driver, udid: "U", via: "auto", conn: conn as any });
    expect(keys).toEqual([]);
    expect(d.marker).toBe("(input: js)");
    expect(d.went).toBe(true);
  });

  it("reports an empty stack instead of pressing the OS back that would exit the app", async () => {
    const { driver, keys } = gestureDriver();
    const { conn } = fakeConn({ went: false, definitive: true, reason: "nothing to go back to" });
    const d = await dispatchBack({ driver, udid: "U", via: "auto", conn: conn as any });
    expect(keys).toEqual([]);
    expect(d.went).toBe(false);
    expect(d.reason).toBe("nothing to go back to");
    expect(d.marker).toBe("(input: js)");
  });

  it("falls back to the hardware key when no navigator was found", async () => {
    const { driver, keys } = gestureDriver();
    const { conn } = fakeConn({ went: false, reason: "no react-navigation container found in the React tree" });
    const d = await dispatchBack({ driver, udid: "U", via: "auto", conn: conn as any });
    expect(keys).toEqual(["back"]);
    expect(d.marker).toContain("(input: os/axe — no react-navigation container found");
  });

  it("via: js refuses rather than falling back", async () => {
    const { driver, keys } = gestureDriver();
    const { conn } = fakeConn({ went: false, reason: "no react-navigation container found in the React tree" });
    await expect(dispatchBack({ driver, udid: "U", via: "js", conn: conn as any })).rejects.toThrow(
      /no react-navigation container/,
    );
    expect(keys).toEqual([]);
  });

  it("via: os never evaluates the expression", async () => {
    const { driver, keys } = gestureDriver();
    const { conn, exprs } = fakeConn({ went: true });
    const d = await dispatchBack({ driver, udid: "U", via: "os", conn: conn as any });
    expect(exprs).toEqual([]);
    expect(keys).toEqual(["back"]);
    expect(d.marker).toBe("(input: os/axe)");
  });
});

describe("dispatchSubmit", () => {
  it("evaluates the submit expression against the named field", async () => {
    const { conn, exprs } = fakeConn({ submitted: true, field: 'testID "search"', handlers: ["onSubmitEditing"] });
    const out = await dispatchSubmit({ conn: conn as any, into: { testID: "search" } });
    expect(out).toMatchObject({ submitted: true, field: 'testID "search"' });
    expect(exprs[0]).toContain('"testID":"search"');
  });

  it("refuses when there is no Metro connection — there is no OS route for enter", async () => {
    await expect(dispatchSubmit({ into: { testID: "search" } })).rejects.toThrow(/Metro connection/);
  });

  it("returns the app's refusal rather than throwing", async () => {
    const { conn } = fakeConn({ submitted: false, reason: "field has no onSubmitEditing handler" });
    const out = await dispatchSubmit({ conn: conn as any });
    expect(out).toEqual({ submitted: false, reason: "field has no onSubmitEditing handler" });
  });
});

describe("osMarker", () => {
  it("names the path alone when nothing needs explaining", () => {
    expect(osMarker({ path: "axe" })).toBe("(input: os/axe)");
    expect(osMarker({ path: "adb" })).toBe("(input: os/adb)");
    expect(osMarker({ path: "runner" })).toBe("(input: os/runner)");
  });

  it("carries the JS path's reason for falling back", () => {
    expect(osMarker({ path: "axe" }, "no Metro connection")).toBe("(input: os/axe — no Metro connection)");
  });

  it("carries the driver's reason for not using the runner", () => {
    expect(osMarker({ path: "axe", reason: "runner starting" })).toBe("(input: os/axe — runner starting)");
  });

  it("puts the JS reason first and the driver's reason second", () => {
    expect(
      osMarker({ path: "adb", reason: "runner failed: install timed out" }, "no press handler in ancestry"),
    ).toBe("(input: os/adb — no press handler in ancestry; runner failed: install timed out)");
  });

  it("ignores empty reasons instead of printing a dangling dash", () => {
    expect(osMarker({ path: "axe", reason: "" }, "")).toBe("(input: os/axe)");
  });

  it("always keeps the `(input: os` prefix callers match on", () => {
    const paths: OsPath[] = [
      { path: "runner" },
      { path: "axe" },
      { path: "adb" },
      { path: "axe", reason: "runner starting" },
    ];
    for (const p of paths) {
      expect(osMarker(p).startsWith("(input: os")).toBe(true);
      expect(osMarker(p, "why").startsWith("(input: os")).toBe(true);
    }
  });
});

describe("the driver's own path and reason reach the marker", () => {
  beforeEach(() => resetHotState());
  const STARTING: OsPath = { path: "axe", reason: "runner starting" };

  it("dispatchTap appends the driver's reason after the JS one", async () => {
    const { driver } = fakeDriver();
    const starting = { ...driver, tapXY: async () => STARTING } as unknown as DeviceDriver;
    const { conn } = fakeConn({ pressed: false, reason: "no press handler in ancestry" });
    const d = await dispatchTap({ driver: starting, udid: "U", x: 1, y: 2, via: "auto", conn });
    expect(d.marker).toBe("(input: os/axe — no press handler in ancestry; runner starting)");
  });

  it("dispatchType names the runner when the driver typed through it", async () => {
    const driver = { platform: "ios", typeText: async () => ({ path: "runner" }) } as unknown as DeviceDriver;
    const out = await dispatchType({ driver, udid: "U", value: "cat", via: "os", verify: false });
    expect(out.marker).toBe("(input: os/runner)");
  });

  it("dispatchSwipe carries a driver-only reason on via: os", async () => {
    const driver = { platform: "ios", swipe: async () => STARTING } as unknown as DeviceDriver;
    const d = await dispatchSwipe({ driver, udid: "U", coords: [1, 2, 3, 4], via: "os" });
    expect(d.marker).toBe("(input: os/axe — runner starting)");
  });

  it("dispatchBack names adb and the missing connection", async () => {
    const driver = { platform: "android", pressKey: async () => ({ path: "adb" }) } as unknown as DeviceDriver;
    const d = await dispatchBack({ driver, udid: "U", via: "auto" });
    expect(d.marker).toBe("(input: os/adb — no Metro connection)");
  });
});
