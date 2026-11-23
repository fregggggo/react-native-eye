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
      inputSchema: {
        path: z.string().optional().describe("Dot-path into the state, e.g. 'user.name' or 'cart.items' for a map of named stores. Omit for the whole state."),
        depth: z.number().int().positive().max(8).optional().describe("How many levels of the value to expand (default 3); deeper levels are summarised."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
        "Depth-limited React component tree via the React DevTools hook, with testID and text where present. max_depth counts only components a developer actually authored — host components (RCTView, RCTText, ...) and structural wrappers (forwardRef/memo/context, styling HOCs) are free and can repeat any number of times without spending budget. RN's own dev-only infrastructure (LogBox, the debugging overlay) is omitted from the output entirely. Large trees are capped and marked truncated rather than returned unbounded. " +
        "To see a screen deep in the app, pass root: '<ComponentName>' — the tree then starts at that component (each mounted instance, up to 5) and max_depth counts from there.",
      inputSchema: {
        max_depth: z.number().int().positive().max(10).optional().describe("Levels of authored components to expand (default 3), counted from the app root or from `root`."),
        root: z.string().min(1).optional().describe("Display name of a component to start the tree at, e.g. 'CheckoutScreen'. Exact, case-sensitive."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ max_depth, root }) => {
      try {
        const conn = await getRegistry().ensure();
        const raw = await conn.evaluate(componentTreeExpression(max_depth ?? 3, root));
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
            // Where the budget ran out is where the caller wants to look next.
            const cut: string[] = Array.isArray(parsed.cutOff) ? parsed.cutOff.filter((n: unknown) => typeof n === "string") : [];
            const where = cut.length
              ? ` Pass root with one of the components the walk stopped at (${cut.slice(0, 5).map((n) => `'${n}'`).join(", ")}) to continue from there,`
              : " Pass root: '<ComponentName>' to start the tree at the part you need,";
            truncatedNote =
              `\n\nNote: this component tree was truncated (it hit the node/depth cap) — the JSON above may be incomplete or cut off mid-value.${where} or a smaller max_depth for a complete answer.`;
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
