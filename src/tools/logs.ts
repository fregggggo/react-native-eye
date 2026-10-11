import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError } from "../core/errors.js";

export function registerLogTools(server: McpServer): void {
  server.registerTool(
    "get_logs",
    {
      title: "Get logs",
      description:
        "Recent console logs from the app. Filter by level and/or search substring. Note: only logs emitted after connect are captured — reload_app to catch cold-start output.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        level: z.enum(["log", "info", "warn", "error", "debug"]).optional(),
        search: z.string().optional(),
      },
    },
    async ({ limit, level, search }) => {
      try {
        const conn = await getRegistry().ensure();
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
          return text(`No logs captured since connect.${gapNote}`);
        }
        const lines = sliced.map((e) => `[${e.level}] ${truncate(e.text, 500)}`);
        return text(lines.join("\n") + gapNote);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
