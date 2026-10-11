import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry, RUNTIME_RELOADING_MESSAGE } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError } from "../core/errors.js";

export function registerErrorTools(server: McpServer): void {
  server.registerTool(
    "get_errors",
    {
      title: "Get errors",
      description:
        "Uncaught exceptions and redboxes captured since connecting. Includes the errors LogBox swallows, which never reach the debugger on their own.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit }) => {
      try {
        const conn = await getRegistry().ensure();
        await conn.installInterceptors("errors");
        // The app buffers what LogBox swallowed; without this the tool answers
        // "No errors captured" under a full-screen redbox (field test D3).
        await conn.drainErrors();
        const entries = conn.errors.last(limit ?? 20);
        if (entries.length === 0) {
          // The re-assert above just ran; if it couldn't confirm the handler
          // is live, this emptiness is untrustworthy rather than a true "no
          // errors happened" (field test D14) — say so and name the lever.
          // That is the more urgent message, so an unhealthy interceptor gets
          // it alone rather than sharing the answer with the blind spots below.
          if (conn.errorInterceptorStatus !== "ok" && conn.runtimeSettling) {
            // Mid-reload the interceptor cannot be healthy yet, and another
            // reload is the one thing that would not help (field test D33).
            return text(
              `No errors captured — ${RUNTIME_RELOADING_MESSAGE}. Error capture is reinstalled automatically when the new runtime starts.`,
            );
          }
          if (conn.errorInterceptorStatus !== "ok") {
            return text(
              `No errors captured. The error interceptor is ${conn.errorInterceptorStatus} — capture may be incomplete; try reload_app.`,
            );
          }
          // Field test G12/G13: an unhandled promise rejection never goes
          // through ErrorUtils, and an error caught by the app's own
          // ErrorBoundary never reaches it either — so a healthy-looking
          // empty answer would read as "the app is fine" when it might not
          // be. Both still show up in LogBox on screen.
          return text(
            "No errors captured. Two kinds are invisible here: an unhandled promise rejection " +
              "(it never goes through ErrorUtils) and an error caught by the app's own ErrorBoundary. " +
              "Both still show up in LogBox on screen — check with screenshot or read_screen_text.",
          );
        }
        // An error from a runtime that has since been replaced is history,
        // not the state of the app now; unmarked, it reads as a new failure.
        return text(
          entries
            .map((e) => `[${e.kind}] ${truncate(e.text, 800)}${conn.errorIsFromEarlierRuntime(e) ? " (before reload)" : ""}`)
            .join("\n"),
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
