import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerNetworkTools, DEV_NOISE } from "../../src/tools/network.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

describe("get_network", () => {
  it("lists requests drained from the interceptor", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_NET__")) {
        return {
          result: {
            value: JSON.stringify([
              { seq: 1, method: "GET", url: "http://api/users", status: 200, durationMs: 12, timestamp: 1 },
            ]),
          },
        };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toContain("GET http://api/users → 200 (12ms)");
  });

  it("shows bodies with detail", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_NET__")) {
        return {
          result: {
            value: JSON.stringify([
              {
                seq: 4,
                method: "POST",
                url: "http://api/login",
                status: 401,
                requestBody: '{"u":1}',
                responseBody: '{"err":"no"}',
                timestamp: 1,
              },
            ]),
          },
        };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", { detail: 4 });
    expect(res.content[0].text).toContain('{"u":1}');
    expect(res.content[0].text).toContain('{"err":"no"}');
  });

  it("re-asserts the interceptor before draining, so a replaced wrapper heals itself", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const evaluated: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      evaluated.push(String(p.expression));
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const atConnect = evaluated.length;
    const server = makeServer();
    registerNetworkTools(server);
    await callTool(server, "get_network", {});
    // Field test D14: a wrapper the app replaced stays dead until something
    // evaluates the source again, and "No network requests captured" then reads
    // as "the app made no requests".
    const calls = evaluated.slice(atConnect);
    const reassertIndex = calls.findIndex((e) => e.includes("__RNE_NET_VERSION__"));
    // The drain expression's body ("...e.seq > N...") is unique to it; the
    // interceptor source never contains it, so this can't be a false match.
    const drainIndex = calls.findIndex((e) => e.includes("e.seq >"));
    expect(reassertIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    // The re-assert must run before the drain, or a wrapper that drifted
    // mid-session is still dead for the very read meant to heal it.
    expect(reassertIndex).toBeLessThan(drainIndex);
  });

  it("heals a dead interceptor mid-call and returns the request it starts capturing", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    // The drain only ever returns the captured entry once the interceptor
    // source has actually been (re-)evaluated on *this* call — proving the
    // fix does something, not merely that a call was issued.
    let healed = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("__RNE_NET_VERSION__")) {
        healed = true;
        return { result: { value: "ok" } };
      }
      if (expr.includes("e.seq >")) {
        return {
          result: {
            value: healed
              ? JSON.stringify([
                  { seq: 1, method: "GET", url: "http://api/healed", status: 200, durationMs: 5, timestamp: 1 },
                ])
              : "[]",
          },
        };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    // Simulate the wrapper going dead again after connect (a fast-refresh
    // replacing fetch): the buffer must stay empty until get_network's own
    // re-assert flips it back.
    healed = false;
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toContain("GET http://api/healed");
  });

  it("names the interceptor status when the buffer comes back empty and it could not be confirmed healthy", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_NET_VERSION__")
        ? { result: { value: "stale" } }
        : { result: { value: undefined } },
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", {});
    // Field test D14: an empty answer next to an unhealed interceptor must not
    // read the same as "the app made no requests".
    expect(res.content[0].text).toContain("No network requests captured.");
    expect(res.content[0].text).toContain("stale");
    expect(res.content[0].text).toContain("reload_app");
  });

  it("says nothing extra when the buffer is empty and the interceptor is healthy", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: "ok" } }));
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toBe("No network requests captured.");
  });

  it("re-asserts only the network interceptor, not the error interceptor", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const evaluated: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      evaluated.push(String(p.expression));
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const atConnect = evaluated.length;
    const server = makeServer();
    registerNetworkTools(server);
    await callTool(server, "get_network", {});
    // get_network has no interest in the error interceptor; re-asserting it
    // too would be a third CDP round-trip nobody asked for.
    expect(evaluated.slice(atConnect).some((e) => e.includes("__RNE_ERR_VERSION__"))).toBe(false);
  });
});

describe("get_network detail lookup", () => {
  async function connectWith(entries: unknown[]) {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_NET__")
        ? { result: { value: JSON.stringify(entries) } }
        : { result: { value: undefined } },
    );
    await getRegistry().connect({ port: metro.port });
  }

  it("finds a request by seq even when a search filter is also given", async () => {
    // detail used to search the *filtered* list, so search + detail reported a
    // request that plainly existed as missing.
    await connectWith([
      { seq: 1, method: "GET", url: "http://api/users", status: 200, responseBody: "[]", timestamp: 1 },
      { seq: 2, method: "GET", url: "http://cdn/img.png", status: 200, timestamp: 2 },
    ]);
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", { search: "cdn", detail: 1 });
    expect(res.content[0].text).toContain("GET http://api/users");
  });

  it("says a body is still loading rather than claiming there is none", async () => {
    await connectWith([{ seq: 1, method: "GET", url: "http://api/x", status: 200, bodyPending: true, timestamp: 1 }]);
    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", { detail: 1 });
    expect(res.content[0].text).toContain("still loading");
  });
});

describe("get_network noise filtering", () => {
  async function connectWith(entries: unknown[]) {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_NET__")
        ? { result: { value: JSON.stringify(entries) } }
        : { result: { value: "ok" } },
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    return server;
  }

  it("hides dev-tooling endpoints by default and shows them with include_dev", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "http://localhost:8099/wait?meta=abc", status: 200, timestamp: 1 },
      { seq: 2, method: "GET", url: "https://api.example.com/users", status: 200, timestamp: 2 },
    ]);
    const hidden = await callTool(server, "get_network", {});
    expect(hidden.content[0].text).toContain("https://api.example.com/users");
    expect(hidden.content[0].text).not.toContain("localhost:8099");
    const shown = await callTool(server, "get_network", { include_dev: true });
    expect(shown.content[0].text).toContain("localhost:8099");
  });

  it("hides every host:port and path listed in DEV_NOISE", async () => {
    const entries = [
      ...DEV_NOISE.ports.map((port, i) => ({
        seq: i + 1,
        method: "GET",
        url: `http://localhost:${port}/anything`,
        status: 200,
        timestamp: i + 1,
      })),
      ...DEV_NOISE.paths.map((path, i) => ({
        seq: 100 + i,
        method: "POST",
        url: `http://192.168.1.5:7777${path}`,
        status: 200,
        timestamp: 100 + i,
      })),
      { seq: 999, method: "GET", url: "https://api.example.com/real", status: 200, timestamp: 999 },
    ];
    const server = await connectWith(entries);
    const res = await callTool(server, "get_network", { limit: 200 });
    const lines = res.content[0].text.split("\n").filter((l: string) => l.startsWith("#"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("https://api.example.com/real");
  });

  it("matches dev noise on host+port+path, not on the query string", async () => {
    // A real request whose query happens to mention a dev path must survive.
    const server = await connectWith([
      { seq: 1, method: "GET", url: "https://api.example.com/track?next=/symbolicate", status: 200, timestamp: 1 },
    ]);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toContain("https://api.example.com/track");
  });

  it("applies the path rules only to local hosts, so a real /status endpoint survives", async () => {
    // Metro's /symbolicate, /logs and /status only ever live on the dev
    // machine; hiding an app's own https://api.example.com/status would be the
    // D14 failure mode again — traffic vanishing with nobody told.
    const server = await connectWith([
      { seq: 1, method: "GET", url: "https://api.example.com/status", status: 200, timestamp: 1 },
      { seq: 2, method: "GET", url: "http://192.168.1.5:8081/status", status: 200, timestamp: 2 },
      { seq: 3, method: "GET", url: "http://localhost/logs", status: 200, timestamp: 3 },
      { seq: 4, method: "POST", url: "http://10.0.2.2/symbolicate", status: 200, timestamp: 4 },
    ]);
    const res = await callTool(server, "get_network", {});
    const lines = res.content[0].text.split("\n").filter((l: string) => l.startsWith("#"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("https://api.example.com/status");
  });

  it("drops entries matching exclude, case-insensitively", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "https://api.example.com/Analytics/beacon", status: 200, timestamp: 1 },
      { seq: 2, method: "GET", url: "https://api.example.com/users", status: 200, timestamp: 2 },
    ]);
    const res = await callTool(server, "get_network", { exclude: ["analytics"] });
    expect(res.content[0].text).toContain("/users");
    expect(res.content[0].text).not.toContain("beacon");
  });

  it("still finds a hidden request by seq, because detail looks across everything captured", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "http://localhost:8099/wait?meta=abc", status: 200, responseBody: "{}", timestamp: 1 },
    ]);
    const res = await callTool(server, "get_network", { detail: 1, exclude: ["wait"] });
    expect(res.content[0].text).toContain("http://localhost:8099/wait?meta=abc");
  });

  it("says how many entries the dev filter hid instead of reading as 'the app made no requests'", async () => {
    // Field test D14's failure mode again: an empty list next to hidden traffic
    // must never let the agent conclude the app is idle.
    const server = await connectWith([
      { seq: 1, method: "GET", url: "http://localhost:8099/wait?meta=abc", status: 200, timestamp: 1 },
      { seq: 2, method: "GET", url: "http://localhost:8081/symbolicate", status: 200, timestamp: 2 },
    ]);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toContain("No network requests captured.");
    expect(res.content[0].text).toContain("2");
    expect(res.content[0].text).toContain("dev noise");
    expect(res.content[0].text).toContain("include_dev: true");
  });

  it("footers the counts when filters hid entries", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "http://localhost:8099/wait?meta=abc", status: 200, timestamp: 1 },
      { seq: 2, method: "GET", url: "https://api.example.com/ads/pixel", status: 200, timestamp: 2 },
      { seq: 3, method: "GET", url: "https://api.example.com/users", status: 200, timestamp: 3 },
    ]);
    const res = await callTool(server, "get_network", { exclude: ["/ads/"] });
    const out = res.content[0].text;
    expect(out).toContain("2 hidden");
    expect(out).toContain("1 dev noise");
    expect(out).toContain("1 excluded");
    expect(out).toContain("include_dev");
    expect(out).toContain("exclude");
  });

  it("says nothing about hidden entries when no filter hid anything", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "https://api.example.com/users", status: 200, durationMs: 3, timestamp: 1 },
    ]);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toBe("#1 GET https://api.example.com/users → 200 (3ms)");
  });
});

describe("get_network list-view URL shortening", () => {
  async function connectWith(entries: unknown[]) {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_NET__")
        ? { result: { value: JSON.stringify(entries) } }
        : { result: { value: "ok" } },
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerNetworkTools(server);
    return server;
  }

  it("collapses a huge query string in the list and keeps the full URL in detail", async () => {
    const query = `meta=${"x".repeat(300)}`;
    const url = `https://api.example.com/wait?${query}`;
    const server = await connectWith([{ seq: 1, method: "GET", url, status: 200, timestamp: 1 }]);
    const list = await callTool(server, "get_network", {});
    expect(list.content[0].text).toContain("https://api.example.com/wait?…(");
    expect(list.content[0].text).toContain(String(query.length));
    expect(list.content[0].text).not.toContain("xxxxxxxxxx");
    const detail = await callTool(server, "get_network", { detail: 1 });
    expect(detail.content[0].text).toContain(url);
  });

  it("keeps a short query string intact", async () => {
    const server = await connectWith([
      { seq: 1, method: "GET", url: "https://api.example.com/users?page=2", status: 200, timestamp: 1 },
    ]);
    const res = await callTool(server, "get_network", {});
    expect(res.content[0].text).toContain("https://api.example.com/users?page=2");
  });

  it("hard-caps a query-less but absurdly long URL", async () => {
    const url = `https://api.example.com/${"seg/".repeat(120)}end`;
    const server = await connectWith([{ seq: 1, method: "GET", url, status: 200, timestamp: 1 }]);
    const res = await callTool(server, "get_network", {});
    const line: string = res.content[0].text.split("\n")[0];
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(220);
  });
});

// Field test D26: right after a reload get_network answered a bare "No network
// requests captured." although the app had certainly fetched at startup — the
// requests it made before the interceptor reached the new runtime are missed by
// design, and the answer has to say so instead of reading as an idle app.
describe("get_network after the JS runtime restarted", () => {
  it("says startup requests before capture was reinstalled are missed", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id: 1, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    const evaluated: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      evaluated.push(expr);
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return { result: { value: JSON.stringify({ s: "ok", v: true }) } };
      return { result: { value: "ok" } };
    });
    await getRegistry().connect({ port: metro.port });
    const at = evaluated.length;
    metro.emit("Runtime.executionContextsCleared", {});
    metro.emit("Runtime.executionContextCreated", { context: { id: 2, name: "main" } });
    const deadline = Date.now() + 3000;
    while (!evaluated.slice(at).some((e) => e.includes("__RNE_NET_VERSION__"))) {
      if (Date.now() > deadline) throw new Error("never reinstalled");
      await new Promise((r) => setTimeout(r, 20));
    }

    const server = makeServer();
    registerNetworkTools(server);
    const res = await callTool(server, "get_network", {});
    const msg = res.content[0].text;
    expect(msg).toContain("No network requests captured.");
    expect(msg).toMatch(/restarted/i);
    expect(msg).toMatch(/missed/i);
  });
  // Field test D33: an unhealthy interceptor in a runtime that is still coming
  // up is a reload in progress — "try reload_app" is exactly the wrong lever.
  it("does not advise reload_app while the new runtime is still being set up", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id: 1, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    let restarted = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      // React never renders in the new runtime, so its setup keeps waiting.
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return { result: { value: JSON.stringify({ s: "ok", v: false }) } };
      if (expr.includes("__RNE_NET_VERSION__")) return { result: { value: restarted ? "failed" : "ok" } };
      return { result: { value: "ok" } };
    });
    await getRegistry().connect({ port: metro.port });
    restarted = true;
    metro.emit("Runtime.executionContextsCleared", {});
    metro.emit("Runtime.executionContextCreated", { context: { id: 2, name: "main" } });
    await new Promise((r) => setTimeout(r, 100));

    const server = makeServer();
    registerNetworkTools(server);
    const msg = (await callTool(server, "get_network", {})).content[0].text;
    expect(msg).toContain("No network requests captured.");
    expect(msg).not.toMatch(/try reload_app/);
    expect(msg).toMatch(/retry in a few seconds/);
  });
});
