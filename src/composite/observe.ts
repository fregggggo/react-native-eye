import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "../tools/context.js";
import { captureScreenshot } from "../tools/screenshot.js";
import { captureLayoutWithSource, layoutWarning, type LayoutSource } from "../tools/layout.js";
import { formatLayout } from "../layout/elements.js";
import { truncate, lostNote } from "../core/format.js";
import { redact } from "../core/redact.js";
import { toToolError } from "../core/errors.js";
import type { DeviceDriver } from "../drivers/types.js";

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function observeInternal(
  opts?: { drivers?: DeviceDriver[]; device?: string },
  o?: { withScreenshot?: boolean; withLayout?: boolean; fullRes?: boolean; source?: LayoutSource },
): Promise<{ content: any[] }> {
  const { driver, udid, conn: live, lost } = await deviceContext(opts);
  // A dropped connection still holds the errors and logs it captured — the
  // moment the app crashed is when they matter most.
  const conn = live ?? lost?.conn;
  const withScreenshot = o?.withScreenshot ?? true;
  const withLayout = o?.withLayout ?? true;

  // Every section is captured independently: a layout timeout used to take the
  // screenshot, the errors and the logs down with it, which is exactly when they
  // are needed most.
  const [shot, layout] = await Promise.all([
    withScreenshot
      ? captureScreenshot(driver, udid, { fullRes: o?.fullRes }).then(
          (c) => ({ ok: true as const, c }),
          (e) => ({ ok: false as const, e }),
        )
      : Promise.resolve(undefined),
    withLayout
      ? captureLayoutWithSource(driver, udid, { conn, source: o?.source }).then(
          (c) => ({ ok: true as const, c }),
          (e) => ({ ok: false as const, e }),
        )
      : Promise.resolve(undefined),
  ]);

  const content: any[] = [];
  const sections: string[] = [];

  // First, before anything else: the elements and the screenshot then show
  // two different apps, and the caller must not act on the elements.
  if (layout && layout.ok && layout.c.appState) sections.push(layoutWarning(layout.c).trimEnd());

  if (shot && shot.ok) {
    content.push(shot.c.image);
    if (shot.c.scaleNote) sections.push(`SCREENSHOT: ${shot.c.scaleNote}`);
  } else if (shot) sections.push(`SCREENSHOT: (unavailable: ${reason(shot.e)})`);

  if (layout) {
    sections.push(
      layout.ok
        ? `LAYOUT (${layout.c.source}${layout.c.note ? ` — ${layout.c.note}` : ""}):\n${formatLayout(layout.c.els)}`
        : `LAYOUT: (unavailable: ${reason(layout.e)})`,
    );
  }

  if (conn) {
    // Pulls in the redboxes LogBox swallowed before reporting "none".
    // Re-assert first: an error interceptor the app unplugged (field test
    // D26) would otherwise leave "none" here under a redbox.
    if (live) {
      await conn.installInterceptors("errors");
      await conn.drainErrors().catch(() => {});
    }
    const errs = conn.errors.last(5);
    sections.push(
      `ERRORS:\n${
        errs.length
          ? errs
              .map((e) => `[${e.kind}] ${truncate(redact(e.text).text, 300)}${conn.errorIsFromEarlierRuntime(e) ? " (before reload)" : ""}`)
              .join("\n")
          : "none"
      }`,
    );
    const logs = conn.logs.last(10);
    const gapNote = conn.logs.gaps.length > 0 ? " (stream has a gap — app reloaded or reconnected)" : "";
    sections.push(
      `LOGS${gapNote}:\n${logs.length ? logs.map((l) => `[${l.level}] ${truncate(redact(l.text).text, 200)}`).join("\n") : "none"}`,
    );
    if (lost) sections.push(lostNote(lost.reason).trim());
  } else {
    sections.push("ERRORS: (no runtime connection — run connect)");
    sections.push("LOGS: (no runtime connection — run connect)");
  }

  content.push({ type: "text", text: sections.join("\n\n") });
  return { content };
}

export function registerObserveTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  server.registerTool(
    "observe",
    {
      title: "Observe",
      description:
        "One-shot snapshot of the screen: screenshot + interactive elements + recent errors + recent logs. Sections are independent — one failing does not lose the rest. Prefer this over separate screenshot/get_layout/get_logs calls.",
      inputSchema: {
        screenshot: z.boolean().optional().describe("Include the screenshot (default true)."),
        full_res: z
          .boolean()
          .optional()
          .describe("Send the screenshot at full resolution instead of downscaled to 800 px on its longest side."),
        source: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("Layout capture path: js = app runtime, os = axe/uiautomator/runner, auto (default) = js, then os."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ screenshot, full_res, source, device }) => {
      try {
        return await observeInternal({ ...opts, device }, { withScreenshot: screenshot ?? true, fullRes: full_res, source });
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
