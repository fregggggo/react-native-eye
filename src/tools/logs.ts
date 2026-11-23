import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate, lostNote } from "../core/format.js";
import { toToolError } from "../core/errors.js";

export function registerLogTools(server: McpServer): void {
  server.registerTool(
    "get_logs",
    {
      title: "Get logs",
      description:
        "Recent console logs from the app. Filter by level and/or search substring. Logs survive a reconnect to the same app, and are still readable after the app crashed or the connection dropped. Note: logs from before connect are only there if the runtime replays them on connect — reload_app to catch cold-start output.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional().describe("How many of the most recent matching lines (default 30)."),
        level: z.enum(["log", "info", "warn", "error", "debug"]).optional().describe("Only lines logged at this level."),
        search: z.string().optional().describe("Only lines containing this text (case-insensitive)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit, level, search }) => {
      try {
        const { conn, lost } = await getRegistry().ensureOrLast();
        let entries = conn.logs.all();
        if (level) entries = entries.filter((e) => e.level === level);
        if (search) {
          const q = search.toLowerCase();
          entries = entries.filter((e) => e.text.toLowerCase().includes(q));
        }
        // A dropped socket or a reload leaves a hole in the stream; showing the
        // remainder as one continuous feed hides that events were lost.
        const gapNote =
          conn.logs.gaps.length > 0
            ? `\n(note: ${conn.logs.gaps.length} gap(s) in this stream — the app reloaded or the connection dropped, logs in between were not captured)`
            : "";
        const sliced = entries.slice(Math.max(0, entries.length - (limit ?? 30)));
        if (sliced.length === 0) {
          // A filter that matched nothing is not an app that logged nothing.
          const total = conn.logs.size();
          if (total > 0 && (level || search)) {
            return text(`No logs match (${total} captured in all).${gapNote}${lostNote(lost)}`);
          }
          return text(`No logs captured since connect.${gapNote}${lostNote(lost)}`);
        }
        const lines = sliced.map((e) => `[${e.level}] ${truncate(e.text, 500)}`);
        return text(lines.join("\n") + gapNote + lostNote(lost));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
