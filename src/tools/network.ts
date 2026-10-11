import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError } from "../core/errors.js";

/**
 * Dev-tooling endpoints hidden from the list view unless `include_dev: true`.
 * A dev poll (e.g. localhost:8099/wait?meta=<huge blob>) repeats every second
 * and buries the app's own traffic, so the default read is useless without it.
 * Matched on host+port+path only — never on the query string, or a real request
 * carrying "/symbolicate" as a parameter value would vanish too.
 */
export const DEV_NOISE = {
  /** Metro (8081-8083), Expo dev server (19000-19002), react-devtools (8097), dev poll (8099). */
  ports: ["8081", "8082", "8083", "8097", "8099", "19000", "19001", "19002"],
  /**
   * Metro endpoints that can sit on a non-default port. Only hidden on a local
   * host: an app's own api.example.com/status is a real request, and
   * hiding it would be the D14 failure mode dressed up as tidiness.
   */
  paths: ["/symbolicate", "/logs", "/status"],
} as const;

/** localhost / loopback / Android emulator alias (10.0.2.2) / private LAN. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  return (
    /^127\./.test(h) ||
    /^10\./.test(h) || // covers the Android emulator's 10.0.2.2 host alias
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** How long a query string may get before the list view collapses it to a count. */
const MAX_QUERY = 80;
/** Hard cap on a rendered list-view URL; the full one stays in detail:<seq>. */
const MAX_URL = 160;

function isDevNoise(url: string): boolean {
  // Parsing is the only way to tell a :8081 *port* from ":8081" appearing in a
  // query value; an unparseable URL falls back to the pre-query substring.
  let port = "";
  let hostname = "";
  let path = url.split(/[?#]/)[0] ?? url;
  try {
    const u = new URL(url);
    port = u.port;
    hostname = u.hostname;
    path = u.pathname;
  } catch {
    const m = /^[a-z]+:\/\/([^/?#:]*)(?::(\d+))?/i.exec(url);
    hostname = m?.[1] ?? "";
    port = m?.[2] ?? "";
  }
  if (port && (DEV_NOISE.ports as readonly string[]).includes(port)) return true;
  if (!isLocalHost(hostname)) return false;
  const lower = path.toLowerCase();
  return (DEV_NOISE.paths as readonly string[]).some((p) => lower === p);
}

/** Collapse the query blob and cap the length — the list is one line per request. */
function shortenUrl(url: string): string {
  const q = url.indexOf("?");
  const shortened =
    q >= 0 && url.length - q - 1 > MAX_QUERY
      ? `${url.slice(0, q)}?…(${url.length - q - 1} chars)`
      : url;
  return truncate(shortened, MAX_URL);
}

/**
 * Field test D26: right after a reload a bare "No network requests captured."
 * read as "the app made no startup requests". Capture can only start once the
 * interceptor is in the new runtime, so whatever the app fetched before that is
 * missed by design — say so, in the same terms as the cold-start note in the
 * tool description.
 */
function restartNote(conn: { runtimeRestartedAt?: number; captureReinstalledAt?: number }): string {
  if (conn.runtimeRestartedAt === undefined) return "";
  const at = new Date(conn.runtimeRestartedAt).toTimeString().slice(0, 8);
  const when =
    conn.captureReinstalledAt !== undefined
      ? `capture was back ${((conn.captureReinstalledAt - conn.runtimeRestartedAt) / 1000).toFixed(1)}s later`
      : "capture is not back in it yet";
  return ` Note: the app's JS runtime restarted at ${at} (reload); ${when}, and requests made before that are missed (cold start).`;
}

export function registerNetworkTools(server: McpServer): void {
  server.registerTool(
    "get_network",
    {
      title: "Get network",
      description:
        "Recent HTTP requests captured in-app. The list view shortens long URLs (query strings collapse to a char count) — pass detail:<seq> for the full URL and request/response bodies. " +
        "Dev-tooling traffic (Metro, Expo, react-devtools, dev polls) is hidden unless include_dev:true; exclude:[...] drops URLs by substring. " +
        "Note: requests before connect are missed (cold start).",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
        search: z.string().optional(),
        exclude: z.array(z.string()).optional(),
        include_dev: z.boolean().optional(),
        detail: z.number().int().optional(),
      },
    },
    async ({ limit, search, exclude, include_dev, detail }) => {
      try {
        const conn = await getRegistry().ensure();
        // Cheap and idempotent: the source returns "ok" without touching
        // anything when its own wrapper is still live. It is what turns a
        // silently replaced interceptor back on instead of reporting an empty
        // buffer as "the app made no requests" (field test D14).
        await conn.installInterceptors("network");
        await conn.drainNetwork();
        const all = conn.network.all();
        // `detail` looks up by seq across everything captured: searching first
        // made `search` + `detail` report a request that plainly exists as missing.
        // The noise filters are list-view only for the same reason.
        if (detail !== undefined) {
          const e = all.find((x) => x.seq === detail);
          if (!e) return text(`No request with seq ${detail}.`);
          const parts = [
            `${e.method} ${e.url}`,
            `status: ${e.status ?? "(none)"}${e.error ? ` error: ${e.error}` : ""}`,
            `duration: ${e.durationMs ?? "?"}ms`,
            `request body: ${e.requestBody ? truncate(e.requestBody, 4000) : "(none)"}`,
            `response body: ${
              e.responseBody ? truncate(e.responseBody, 4000) : e.bodyPending ? "(still loading — retry)" : "(none)"
            }`,
          ];
          return text(parts.join("\n"));
        }
        let entries = all;
        if (search) {
          const q = search.toLowerCase();
          entries = entries.filter((e) => e.url.toLowerCase().includes(q));
        }
        const excludes = (exclude ?? []).map((s) => s.toLowerCase()).filter((s) => s.length > 0);
        let devHidden = 0;
        let excluded = 0;
        entries = entries.filter((e) => {
          const url = e.url.toLowerCase();
          if (excludes.some((x) => url.includes(x))) {
            excluded++;
            return false;
          }
          if (!include_dev && isDevNoise(e.url)) {
            devHidden++;
            return false;
          }
          return true;
        });
        const sliced = entries.slice(Math.max(0, entries.length - (limit ?? 20)));
        if (sliced.length === 0) {
          // The re-assert above just ran; if it couldn't confirm the wrapper
          // is live, this emptiness is untrustworthy rather than a true "the
          // app made no requests" (field test D14) — say so and name the lever.
          // Mid-reload it cannot be healthy yet, and another reload is the one
          // thing that would not help (field test D33).
          const unhealthy =
            conn.interceptorStatus === "ok"
              ? ""
              : conn.runtimeSettling
                ? ` The app's JS runtime is still starting after a reload — network capture is reinstalled automatically; retry in a few seconds.`
                : ` The network interceptor is ${conn.interceptorStatus} — capture may be incomplete; try reload_app.`;
          // Same failure mode as D14 from the other direction: traffic the
          // default filter swallowed must never read as an idle app.
          const noise = devHidden ? ` ${devHidden} hidden as dev noise — pass include_dev: true to see them.` : "";
          const dropped = excluded ? ` ${excluded} hidden by exclude.` : "";
          return text(`No network requests captured.${noise}${dropped}${unhealthy}${restartNote(conn)}`);
        }
        const lines = sliced.map(
          (e) =>
            `#${e.seq} ${e.method} ${shortenUrl(e.url)} → ${e.error ? "ERR" : e.status ?? "?"} (${e.durationMs ?? "?"}ms)`,
        );
        if (devHidden || excluded) {
          const what = [devHidden ? `${devHidden} dev noise` : "", excluded ? `${excluded} excluded` : ""].filter(Boolean);
          const levers = [devHidden ? "include_dev: true" : "", excluded ? "exclude" : ""].filter(Boolean);
          lines.push(`(${devHidden + excluded} hidden: ${what.join(", ")} — ${levers.join(" / ")})`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
