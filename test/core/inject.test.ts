import { describe, it, expect } from "vitest";
import {
  NETWORK_INTERCEPTOR_SOURCE,
  drainNetworkExpression,
  ERROR_INTERCEPTOR_SOURCE,
  drainErrorsExpression,
} from "../../src/core/inject.js";

function install(g: any): any {
  const fn = new Function("globalThis", NETWORK_INTERCEPTOR_SOURCE + "\nreturn globalThis;");
  return fn(g);
}

/**
 * React Native's XMLHttpRequest throws from the `responseText` getter unless
 * responseType is ""/"text" — and RN's fetch (whatwg-fetch) sets it to "blob" on
 * every request. Reproduced faithfully here, because reading it unguarded both
 * lost the request and printed an error inside the app under test.
 */
class RnXhrLike {
  responseType = "blob";
  status = 200;
  private listeners: Record<string, (() => void)[]> = {};
  get responseText(): string {
    throw new Error(
      "The 'responseText' property is only available if 'responseType' is set to '' or 'text', but it is 'blob'.",
    );
  }
  open(_method: string, _url: string): void {}
  send(_body?: unknown): void {}
  addEventListener(name: string, fn: () => void): void {
    (this.listeners[name] ??= []).push(fn);
  }
  fire(name: string): void {
    for (const fn of this.listeners[name] ?? []) fn();
  }
}

describe("network interceptor snippet", () => {
  it("installs into a sandbox and records a fetch", async () => {
    const calls: string[] = [];
    const g: any = {
      fetch: async (url: string) => {
        calls.push(url);
        return { status: 200, clone: () => ({ text: async () => "ok" }) };
      },
    };
    const out = install(g);
    await out.fetch("http://x/api");
    await new Promise((r) => setTimeout(r, 0));
    expect(out.__RNE_NET__.length).toBe(1);
    expect(out.__RNE_NET__[0].url).toBe("http://x/api");
    expect(out.__RNE_NET__[0].method).toBe("GET");
  });

  it("records the XHR without throwing when responseText is unreadable", () => {
    const g: any = { XMLHttpRequest: RnXhrLike };
    const out = install(g);
    const xhr: any = new out.XMLHttpRequest();
    xhr.open("POST", "http://x/graphql");
    xhr.send("{}");
    // The listener must not throw: in the app this surfaced as a console.error
    // and a LogBox redbox on every single blob request.
    expect(() => xhr.fire("loadend")).not.toThrow();
    expect(out.__RNE_NET__).toHaveLength(1);
    expect(out.__RNE_NET__[0]).toMatchObject({ method: "POST", url: "http://x/graphql", status: 200 });
    expect(out.__RNE_NET__[0].responseBody).toBeUndefined();
  });

  it("still captures the body when responseType allows it", () => {
    class TextXhr extends RnXhrLike {
      responseType = "text";
      get responseText(): string {
        return "hello";
      }
    }
    const g: any = { XMLHttpRequest: TextXhr };
    const out = install(g);
    const xhr: any = new out.XMLHttpRequest();
    xhr.open("GET", "http://x/t");
    xhr.send();
    xhr.fire("loadend");
    expect(out.__RNE_NET__[0].responseBody).toBe("hello");
  });

  it("re-offers an entry once its body lands, so a late body is not stranded", async () => {
    let release: (v: string) => void = () => {};
    const g: any = {
      fetch: async () => ({
        status: 200,
        clone: () => ({ text: () => new Promise<string>((r) => (release = r)) }),
      }),
    };
    const out = install(g);
    await out.fetch("http://x/slow");

    // Drained before the body arrives: recorded, marked pending, no body yet.
    const firstDrain = JSON.parse(new Function("globalThis", `return ${drainNetworkExpression(0)}`)(out));
    expect(firstDrain).toHaveLength(1);
    expect(firstDrain[0].bodyPending).toBe(true);
    expect(firstDrain[0].responseBody).toBeUndefined();

    release("payload");
    await new Promise((r) => setTimeout(r, 0));

    // The seq is old, but the entry is dirty and must come back with its body.
    const seq = firstDrain[0].seq;
    const secondDrain = JSON.parse(new Function("globalThis", `return ${drainNetworkExpression(seq)}`)(out));
    expect(secondDrain).toHaveLength(1);
    expect(secondDrain[0].seq).toBe(seq);
    expect(secondDrain[0].responseBody).toBe("payload");

    // …and only once: the dirty flag is cleared by the drain.
    const thirdDrain = JSON.parse(new Function("globalThis", `return ${drainNetworkExpression(seq)}`)(out));
    expect(thirdDrain).toHaveLength(0);
  });

  it("is idempotent", () => {
    const g: any = { fetch: async () => ({ status: 200, clone: () => ({ text: async () => "" }) }) };
    install(g);
    const first = g.fetch;
    install(g);
    expect(g.fetch).toBe(first); // not re-wrapped
  });

  it("drainNetworkExpression filters by seq", () => {
    expect(drainNetworkExpression(5)).toContain("> 5");
    expect(drainNetworkExpression(5)).toContain("__RNE_NET__");
  });

  it("re-wraps when the app replaced fetch after the flags were set", async () => {
    const respond = (url: string) => ({ status: 200, clone: () => ({ text: async () => "ok" }) });
    const g: any = { fetch: async (url: string) => respond(url) };
    install(g);
    // Field test D14: reload_app installs the interceptor at the very start of
    // the new runtime, and the bundle's own init then puts its fetch back on
    // top. The flags still say "installed at this version", so every later
    // install short-circuited and capture stayed silently dead.
    const appFetch = async (url: string) => respond(url);
    g.fetch = appFetch;
    const out = install(g);
    expect(out.fetch).not.toBe(appFetch);
    await out.fetch("http://x/after-reload");
    await new Promise((r) => setTimeout(r, 0));
    expect(out.__RNE_NET__.map((e: any) => e.url)).toContain("http://x/after-reload");
  });

  it("does not re-wrap when its own wrapper is still the live one", async () => {
    const g: any = { fetch: async () => ({ status: 200, clone: () => ({ text: async () => "ok" }) }) };
    const first = install(g);
    const wrapper = first.fetch;
    const second = install(g);
    expect(second.fetch).toBe(wrapper);
    await second.fetch("http://x/once");
    await new Promise((r) => setTimeout(r, 0));
    // Double-wrapping is the failure this guard must not cause: one call, one entry.
    expect(second.__RNE_NET__.filter((e: any) => e.url === "http://x/once")).toHaveLength(1);
  });

  it("re-wraps only the mechanism that drifted, leaving the other's originals alone", () => {
    const g: any = {
      XMLHttpRequest: RnXhrLike,
      fetch: async () => ({ status: 200, clone: () => ({ text: async () => "ok" }) }),
    };
    install(g);
    // Only fetch drifts, as a bundle re-init would after reload; the XHR send
    // wrapper installed a moment ago is still the live one, untouched.
    const appFetch = async () => ({ status: 200, clone: () => ({ text: async () => "ok" }) });
    g.fetch = appFetch;
    const out = install(g);
    expect(out.fetch).not.toBe(appFetch); // the drifted one is re-wrapped…
    const xhr: any = new out.XMLHttpRequest();
    xhr.open("GET", "http://x/bare");
    xhr.send();
    xhr.fire("loadend");
    // …while the live XHR wrapper is left alone, not chained onto itself: one
    // bare request must still be one entry, not two.
    expect(out.__RNE_NET__.filter((e: any) => e.url === "http://x/bare")).toHaveLength(1);
  });
});

describe("fetch built on XHR (React Native's own)", () => {
  /** whatwg-fetch: opens and sends an XHR synchronously inside the fetch call. */
  function rnStyleFetch(g: any) {
    return (url: string) =>
      new Promise((resolve) => {
        const xhr: any = new g.XMLHttpRequest();
        xhr.open("GET", url);
        xhr.send();
        setTimeout(() => {
          xhr.fire("loadend");
          resolve({ status: 200, clone: () => ({ text: async () => "body" }) });
        }, 0);
      });
  }

  it("records one entry per request, not one per wrapper", async () => {
    // Both wrappers used to fire; the XHR one only stayed invisible because
    // reading responseText threw.
    const g: any = { XMLHttpRequest: RnXhrLike };
    g.fetch = rnStyleFetch(g);
    const out = install(g);
    await out.fetch("http://api/thing");
    await new Promise((r) => setTimeout(r, 5));
    expect(out.__RNE_NET__).toHaveLength(1);
    expect(out.__RNE_NET__[0].url).toBe("http://api/thing");
  });

  it("still records a bare XHR that no fetch owns", async () => {
    const g: any = { XMLHttpRequest: RnXhrLike };
    g.fetch = rnStyleFetch(g);
    const out = install(g);
    const xhr: any = new out.XMLHttpRequest();
    xhr.open("PUT", "http://api/direct");
    xhr.send("payload");
    xhr.fire("loadend");
    expect(out.__RNE_NET__.map((e: any) => e.url)).toEqual(["http://api/direct"]);
  });

  it("clears the flag even when fetch throws synchronously", async () => {
    const g: any = { XMLHttpRequest: RnXhrLike };
    g.fetch = () => {
      throw new Error("network down");
    };
    const out = install(g);
    expect(() => out.fetch("http://api/x")).toThrow(/network down/);
    expect(out.__RNE_IN_FETCH__).toBe(0);
  });
});

describe("re-installing over an older build", () => {
  it("replaces its own hooks when the version moved on", () => {
    const g: any = { XMLHttpRequest: RnXhrLike, fetch: async () => ({ status: 200, clone: () => ({ text: async () => "" }) }) };
    const realFetch = g.fetch;
    install(g);
    const firstWrapper = g.fetch;
    // Same source, but pretend the installed one is older.
    g.__RNE_NET_VERSION__ = 1;
    install(g);
    expect(g.fetch).not.toBe(firstWrapper); // re-wrapped…
    expect(g.__RNE_ORIG_FETCH__).toBe(realFetch); // …from the original, not on top of the old wrapper
  });

  it("refuses to stack on top of a build that saved no originals", () => {
    // The app outlives the server: an old buggy interceptor may still be in
    // place with nothing to restore. Wrapping again would double-count.
    const g: any = { fetch: async () => ({ status: 200, clone: () => ({ text: async () => "" }) }) };
    const preexisting = g.fetch;
    g.__RNE_NET_INSTALLED__ = true; // an old build, no __RNE_ORIG_FETCH__
    const fn = new Function("globalThis", NETWORK_INTERCEPTOR_SOURCE + "\nreturn globalThis.__rneResult;");
    const wrapped = new Function(
      "globalThis",
      `globalThis.__rneResult = ${NETWORK_INTERCEPTOR_SOURCE.trim().replace(/;$/, "")}; return globalThis.__rneResult;`,
    );
    const status = wrapped(g);
    expect(status).toBe("stale");
    expect(g.fetch).toBe(preexisting); // untouched
    void fn;
  });
});

/**
 * In a dev build LogBox installs itself as the ErrorUtils global handler: it
 * shows the redbox and swallows the exception, so CDP's Runtime.exceptionThrown
 * never fires. That is why `get_errors` answered "No errors captured" while a
 * full-screen redbox was up (field test D3). The interceptor chains onto that
 * handler instead of replacing it.
 */
function logBoxLike() {
  const shown: { err: unknown; isFatal?: boolean }[] = [];
  let handler = (err: unknown, isFatal?: boolean) => {
    shown.push({ err, isFatal });
  };
  const g: any = {
    ErrorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (h: typeof handler) => {
        handler = h;
      },
    },
    throwUncaught: (err: unknown, isFatal?: boolean) => handler(err, isFatal),
  };
  return { g, shown };
}

function runErrors(g: any): unknown {
  return new Function("globalThis", `return ${ERROR_INTERCEPTOR_SOURCE.trim()}`)(g);
}

function installErrors(g: any): any {
  runErrors(g);
  return g;
}

describe("error interceptor snippet", () => {
  it("captures an uncaught error that LogBox would otherwise swallow", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("rne-uncaught-probe"), true);
    expect(out.__RNE_ERR__).toHaveLength(1);
    expect(out.__RNE_ERR__[0].text).toContain("rne-uncaught-probe");
    expect(out.__RNE_ERR__[0].seq).toBe(1);
  });

  it("still calls the handler it replaced, so the redbox keeps showing", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    const err = new Error("boom");
    out.throwUncaught(err, true);
    expect(shown).toHaveLength(1);
    expect(shown[0].err).toBe(err);
    expect(shown[0].isFatal).toBe(true);
  });

  it("marks a fatal error as a redbox and a non-fatal one as a warning", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("fatal one"), true);
    out.throwUncaught(new Error("soft one"), false);
    expect(out.__RNE_ERR__[0].kind).toBe("redbox");
    expect(out.__RNE_ERR__[1].kind).toBe("exception");
  });

  it("records the stack when the thrown value carries one", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("with stack"), true);
    expect(typeof out.__RNE_ERR__[0].stack).toBe("string");
    expect(out.__RNE_ERR__[0].stack.length).toBeGreaterThan(0);
  });

  it("never throws into app code for an exotic thrown value", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    const hostile = {
      get message(): string {
        throw new Error("message getter throws");
      },
      get stack(): string {
        throw new Error("stack getter throws");
      },
    };
    expect(() => out.throwUncaught(hostile, true)).not.toThrow();
    expect(() => out.throwUncaught("a bare string", false)).not.toThrow();
    expect(() => out.throwUncaught(null, true)).not.toThrow();
    // The app's own handler must still run for every one of them.
    expect(shown).toHaveLength(3);
  });

  it("reports 'unavailable' when the app exposes no ErrorUtils", () => {
    expect(runErrors({})).toBe("unavailable");
  });

  it("reports 'unavailable' and leaves the real handler alone when getGlobalHandler throws", () => {
    let setCalls = 0;
    const g: any = {
      ErrorUtils: {
        getGlobalHandler: () => {
          throw new Error("getGlobalHandler is broken on this runtime");
        },
        setGlobalHandler: () => {
          setCalls++;
        },
      },
    };

    expect(runErrors(g)).toBe("unavailable");
    // The real assertion: a read failure must not be treated as "no handler
    // yet" and used as license to overwrite the slot. If it ever calls
    // setGlobalHandler here, whatever ErrorUtils currently calls — real or
    // app-installed — is silently dropped and the app stops painting its redbox.
    expect(setCalls).toBe(0);
    expect(g.__RNE_ERR_INSTALLED__).toBeUndefined();
    expect(g.__RNE_ERR_HANDLER__).toBeUndefined();
  });

  it("does not chain a second time when re-installed at the same version", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    expect(runErrors(out)).toBe("ok");
    out.throwUncaught(new Error("once"), true);
    expect(out.__RNE_ERR__).toHaveLength(1);
    expect(shown).toHaveLength(1);
  });

  it("re-chains when something replaced the global handler at the same version", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    // Field test D13: reload_app never reinstalled this at all, and even when it
    // does, the app's own LogBox takes the handler slot back during boot. The
    // version check then reported "ok" over a handler that is no longer ours.
    out.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
      shown.push({ err, isFatal });
    });

    expect(runErrors(out)).toBe("ok");
    out.throwUncaught(new Error("boom"), true);

    expect(out.__RNE_ERR__.map((e: any) => e.text)).toContain("Error: boom");
    // The app must keep behaving as it did: LogBox still paints its redbox.
    expect(shown).toHaveLength(1);
  });

  // Field test D26: on a slow emulator the interceptor went on first and the
  // app's own setGlobalHandler call came after it, replacing ours outright.
  // The re-assert on the next tool call heals the chain, but only after the
  // error the agent was looking for had already gone to LogBox alone.
  it("keeps capturing when the app installs its own handler after us", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    let appCalls = 0;
    out.ErrorUtils.setGlobalHandler((_err: unknown, _isFatal?: boolean) => {
      appCalls++;
    });

    out.throwUncaught(new Error("rne-ft3-after-reload"), true);

    expect(out.__RNE_ERR__.map((e: any) => e.text)).toContain("Error: rne-ft3-after-reload");
    // The app's handler is what it asked for — it runs, exactly as without us,
    // and the one it replaced does not (that is the app's choice, not ours).
    expect(appCalls).toBe(1);
    expect(shown).toHaveLength(0);
  });

  it("hides itself from getGlobalHandler, so an app that chains never loops back into it", () => {
    const { g, shown } = logBoxLike();
    const out = installErrors(g);
    const before = out.ErrorUtils.getGlobalHandler();
    expect(before).not.toBe(out.__RNE_ERR_HANDLER__);
    let appCalls = 0;
    // The common crash-reporter pattern: wrap whatever is installed now.
    out.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
      appCalls++;
      before(err, isFatal);
    });

    out.throwUncaught(new Error("chained"), true);

    expect(out.__RNE_ERR__).toHaveLength(1);
    expect(appCalls).toBe(1);
    expect(shown).toHaveLength(1);
  });

  it("reports healthy without chaining again after the app's later setGlobalHandler", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.ErrorUtils.setGlobalHandler(() => {});
    expect(runErrors(out)).toBe("ok");
    out.throwUncaught(new Error("once"), true);
    expect(out.__RNE_ERR__).toHaveLength(1);
  });

  it("re-chains when the app swapped in a whole new ErrorUtils object", () => {
    const first = logBoxLike();
    const out = installErrors(first.g);
    const second = logBoxLike();
    out.ErrorUtils = second.g.ErrorUtils;
    out.throwUncaught = second.g.throwUncaught;

    expect(runErrors(out)).toBe("ok");
    out.throwUncaught(new Error("after swap"), true);

    expect(out.__RNE_ERR__.map((e: any) => e.text)).toContain("Error: after swap");
    expect(second.shown).toHaveLength(1);
  });

  it("still works, and does not chain again on every re-assert, when ErrorUtils is frozen", () => {
    const { g, shown } = logBoxLike();
    Object.freeze(g.ErrorUtils);
    const out = installErrors(g);
    expect(runErrors(out)).toBe("ok");
    expect(runErrors(out)).toBe("ok");
    out.throwUncaught(new Error("frozen"), true);
    expect(out.__RNE_ERR__).toHaveLength(1);
    expect(shown).toHaveLength(1);
  });

  it("does not recurse when a stale reference chains back into it", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    const ours = out.__RNE_ERR_HANDLER__;
    // Something that grabbed our handler by other means and chains to it.
    out.ErrorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => ours(err, isFatal));
    expect(() => out.throwUncaught(new Error("loop"), true)).not.toThrow();
    expect(out.__RNE_ERR__).toHaveLength(1);
  });

  it("caps the buffer so a redbox loop cannot grow the app's memory", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    for (let i = 0; i < 80; i++) out.throwUncaught(new Error(`e${i}`), true);
    expect(out.__RNE_ERR__.length).toBeLessThanOrEqual(50);
    expect(out.__RNE_ERR__[out.__RNE_ERR__.length - 1].text).toContain("e79");
  });
});

describe("drainErrorsExpression", () => {
  const drain = (g: any): any[] =>
    JSON.parse(new Function("globalThis", `return ${drainErrorsExpression()}`)(g) as string);

  it("hands over everything the app captured", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("first"), true);
    out.throwUncaught(new Error("second"), true);
    expect(drain(out).map((e: any) => e.text)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  // Taking the entries clears them in the same synchronous expression. A
  // watermark instead of a hand-over would go blind the moment the app's own
  // counter restarted — which is the exact failure this whole path exists to fix.
  it("does not hand the same error over twice", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("once"), true);
    expect(drain(out)).toHaveLength(1);
    expect(drain(out)).toHaveLength(0);
  });

  it("keeps recording after a drain", () => {
    const { g } = logBoxLike();
    const out = installErrors(g);
    out.throwUncaught(new Error("before"), true);
    drain(out);
    out.throwUncaught(new Error("after"), true);
    expect(drain(out)[0].text).toContain("after");
  });

  it("returns an empty list when the app never installed the buffer", () => {
    expect(drain({})).toEqual([]);
  });
});
