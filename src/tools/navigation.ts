import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError, UserInputError, RuntimeError } from "../core/errors.js";
import {
  navStateExpression,
  navActionExpression,
  type NavLevel,
  type NavResult,
} from "../state/navSnippets.js";

// Long enough for the navigator to commit the transition, short enough that a
// tool call still feels immediate. Lives inside the injected expression (see
// navActionExpression) rather than as a second evaluate.
const SETTLE_MS = 150;

/** `{id: 42, q: "x"}` — compact enough to sit inline next to a route name. */
function compactParams(params: unknown): string {
  if (params === null || typeof params !== "object") return String(params);
  if (Array.isArray(params)) return JSON.stringify(params);
  const body = Object.keys(params as Record<string, unknown>)
    .map((k) => `${k}: ${JSON.stringify((params as Record<string, unknown>)[k])}`)
    .join(", ");
  return `{${body}}`;
}

function routeLabel(r: NavLevel["routes"][number]): string {
  if (r.paramsNote) return `${r.name} ${r.paramsNote}`;
  if (r.params === undefined) return r.name;
  return `${r.name} ${truncate(compactParams(r.params), 80)}`;
}

/**
 * One line per nesting level, each prefixed with the path of navigators above
 * it and ending with that level's routes, the focused one marked:
 *
 *   Current: Post {id: 42}
 *   Root(stack): Tabs ←
 *   Root(stack) > Tabs(tab): Home, HomeStack ←
 *   Root(stack) > Tabs(tab) > HomeStack(stack): Feed, Post {id: 42} ←
 *
 * Only the focused branch is expanded: a sibling tab's stack is state the app
 * keeps but nothing is looking at, and printing all of it buries the one path
 * that is actually on screen.
 */
export function formatNavStack(state: NavLevel | undefined): string {
  if (!state) {
    return "A navigation container was found, but it has no state yet (the navigator is not ready — is it still mounting?).";
  }
  const lines: string[] = [];
  const crumbs: string[] = [];
  let level: NavLevel | undefined = state;
  let label = "Root";
  let focused = "";
  // The nesting depth is bounded in the app already (__rneNavSnapshot); the
  // guard here is only so a hand-built or foreign state cannot loop forever.
  for (let depth = 0; level && depth < 10; depth++) {
    crumbs.push(`${label}(${level.type ?? "?"})`);
    const idx: number = level.index ?? 0;
    const routes: string[] = level.routes.map(
      (r, i) => `${routeLabel(r)}${i === idx ? " ←" : ""}`,
    );
    if (level.more) routes.push(`…(+${level.more} more)`);
    lines.push(`${crumbs.join(" > ")}: ${routes.join(", ")}`);
    const cur: NavLevel["routes"][number] | undefined = level.routes[idx];
    if (!cur) break;
    focused = routeLabel(cur);
    label = cur.name;
    level = cur.state;
  }
  return [`Current: ${focused}`, ...lines].join("\n");
}

export function registerNavigationTools(server: McpServer): void {
  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description:
        "Read or drive react-navigation (and Expo Router) from outside the app. `stack` reports the current navigation state — one line per nesting level with the focused route marked. `navigate`/`push` go to a route by name (push always adds a new card, navigate reuses an existing one), `back`/`pop`/`pop_to_top` unwind it, `reset` replaces the whole state via resetRoot. Every mutating action reports the resulting stack. The navigation container ref is found by walking the React tree, so no app-side setup is needed; it is cached on globalThis.__RNE_NAV__ until the next reload. An unknown route name comes back as react-navigation's own \"was not handled by any navigator\" message.",
      inputSchema: {
        action: z.enum(["stack", "navigate", "push", "back", "pop", "pop_to_top", "reset"]),
        name: z.string().optional(),
        params: z.record(z.unknown()).optional(),
        count: z.number().int().positive().max(50).optional(),
        state: z.record(z.unknown()).optional(),
      },
    },
    async ({ action, name, params, count, state }) => {
      try {
        if ((action === "navigate" || action === "push") && !name) {
          throw new UserInputError(`'${action}' needs a route "name" — run navigate with action "stack" to see the route names this navigator knows.`);
        }
        const conn = await getRegistry().ensure();
        const expr =
          action === "stack"
            ? navStateExpression()
            : navActionExpression({ action, name, params, count, state }, SETTLE_MS);
        const raw = await conn.evaluate(
          expr,
          // The expression waits out the settle in-app, so the eval timeout has
          // to outlast it by more than the round trip.
          { timeoutMs: 15000 },
        );
        const str = typeof raw === "string" ? raw : JSON.stringify(raw);
        let res: NavResult;
        try {
          res = JSON.parse(str);
        } catch {
          throw new RuntimeError(`unexpected answer from the app: ${truncate(str, 300)}`);
        }
        if (!res.found) {
          throw new UserInputError(
            `No navigation container found — ${res.reason ?? "unknown reason"}. ` +
              "If your app uses a navigation library other than react-navigation, assign its ref to globalThis.__RNE_NAV__ (it needs getRootState and navigate/dispatch).",
          );
        }
        if (res.error) throw new RuntimeError(res.error);
        // react-navigation reports an unroutable action by logging, not by
        // throwing, so without this the call would look like it worked and
        // return an unchanged stack.
        if (res.unhandled) throw new UserInputError(truncate(res.unhandled, 600));
        const head = res.note ? `${res.note}\n` : "";
        return text(head + formatNavStack(res.state));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
