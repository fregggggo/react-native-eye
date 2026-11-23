import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { getStateExpression, currentRouteExpression } from "../state/snippets.js";
import { text, truncate, lostNote } from "../core/format.js";
import { Redactor } from "../core/redact.js";
import { toToolError } from "../core/errors.js";

export function registerCheckStateTools(server: McpServer): void {
  server.registerTool(
    "check_state",
    {
      title: "Check state",
      description:
        "One-shot: current route + store state (optional dot-path) + recent errors. The route is discovered automatically — the react-navigation container ref is found by walking the React tree, so no app-side setup is needed (globalThis.__RNE_ROUTE__ / globalThis.__RNE_NAV__ still take precedence when the app publishes them). If no navigator is found the route is null and the hint says why.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Dot-path into the store state to return (e.g. auth.user); default: the whole state, truncated."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const { conn, lost } = await getRegistry().ensureOrLast();
        if (lost) {
          // Route and store live in the runtime that is gone; the errors it
          // raised before going are still here and are what explains it.
          const red = new Redactor();
          const kept = conn.errors.last(5);
          const errText = kept.length
            ? kept
                .map((e) => `[${e.kind}] ${truncate(red.apply(e.text), 300)}${conn.errorIsFromEarlierRuntime(e) ? " (before reload)" : ""}`)
                .join("\n")
            : "none";
          return text(
            `ROUTE:\n(unavailable: not connected)\n\nSTATE:\n(unavailable: not connected)\n\nERRORS:\n${errText}${red.note()}${lostNote(lost)}`,
          );
        }
        // Sections are independent: a missing store must not hide the errors.
        const routeRaw = await conn
          .evaluate(currentRouteExpression())
          .catch((e) => JSON.stringify({ route: null, error: e instanceof Error ? e.message : String(e) }));
        const stateRaw = await conn
          .evaluate(getStateExpression(path))
          .catch((e) => JSON.stringify({ found: false, error: e instanceof Error ? e.message : String(e) }));
        // Re-assert first: an error interceptor the app unplugged (field test
        // D26) would otherwise leave "none" here under a redbox.
        await conn.installInterceptors("errors");
        await conn.drainErrors().catch(() => {});
        const errs = conn.errors.last(5);
        const red = new Redactor();
        const errText = errs.length
          ? errs
              .map((e) => `[${e.kind}] ${truncate(red.apply(e.text), 300)}${conn.errorIsFromEarlierRuntime(e) ? " (before reload)" : ""}`)
              .join("\n")
          : "none";
        // JSON.stringify(undefined) is undefined, not a string — an empty answer
        // from one section used to throw and take the other two down with it,
        // which is exactly what this tool promises not to do.
        const asText = (v: unknown, fallback: string): string =>
          typeof v === "string" ? v : (JSON.stringify(v) ?? fallback);
        const route = asText(routeRaw, "(no answer from the app)");
        const state = asText(stateRaw, "(no answer from the app)");
        return text(`ROUTE:\n${truncate(route, 500)}\n\nSTATE:\n${truncate(red.apply(state), 3000)}\n\nERRORS:\n${errText}${red.note()}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
