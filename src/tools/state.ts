import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError } from "../core/errors.js";
import { getStateExpression, componentTreeExpression } from "../state/snippets.js";

export function registerStateTools(server: McpServer): void {
  server.registerTool(
    "get_state",
    {
      title: "Get state",
      description:
        "Read app store state (Redux/Zustand/custom), summarised depth-first inside the app so the result stays valid JSON. Optionally a dot-path (e.g. 'user.name') and a depth (default 3). `resolved` says whether the path actually walked to a value — a mistyped segment reports `resolved:false` with `failedAt` and `availableKeys` instead of silently looking the same as an honest `undefined`. Assign your store to globalThis.__RNE_STORES__ for reliable access.",
      inputSchema: { path: z.string().optional(), depth: z.number().int().positive().max(8).optional() },
    },
    async ({ path, depth }) => {
      try {
        const conn = await getRegistry().ensure();
        const raw = await conn.evaluate(getStateExpression(path, depth ?? 3));
        return text(truncate(typeof raw === "string" ? raw : JSON.stringify(raw), 4000));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "get_component_tree",
    {
      title: "Get component tree",
      description:
        "Depth-limited React component tree via the React DevTools hook, with testID and text where present. max_depth counts only components a developer actually authored — host components (RCTView, RCTText, ...) and structural wrappers (forwardRef/memo/context, styling HOCs) are free and can repeat any number of times without spending budget. RN's own dev-only infrastructure (LogBox, the debugging overlay, the root tag context) is omitted from the output entirely. Large trees are capped and marked truncated rather than returned unbounded.",
      inputSchema: { max_depth: z.number().int().positive().max(10).optional() },
    },
    async ({ max_depth }) => {
      try {
        const conn = await getRegistry().ensure();
        const raw = await conn.evaluate(componentTreeExpression(max_depth ?? 3));
        const str = typeof raw === "string" ? raw : JSON.stringify(raw);
        // Read `truncated` off the full, untruncated string before slicing it
        // for the wire: a tree big enough to set the flag is also big enough
        // that the 4000-char cap below can (and for a real 500-node tree,
        // will) cut the flag itself off, leaving invalid JSON with no visible
        // sign anything was cut. Telling the caller here, in plain response
        // text, means they never have to parse (possibly invalid) JSON to
        // find out the answer was incomplete (field test 2 review, finding 3).
        let truncatedNote = "";
        try {
          const parsed = JSON.parse(str);
          if (parsed && parsed.truncated === true) {
            truncatedNote =
              "\n\nNote: this component tree was truncated (it hit the node/depth cap) — the JSON above may be incomplete or cut off mid-value. Pass a smaller max_depth for a complete answer.";
          }
        } catch {
          // Not parseable JSON (a foreign/older runtime) — nothing to add.
        }
        return text(truncate(str, 4000) + truncatedNote);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
