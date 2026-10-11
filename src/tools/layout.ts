import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { toElements, formatLayout, withdrawOverlay, type Element } from "../layout/elements.js";
import { searchElements, elementAtPoint } from "../layout/search.js";
import { fastLayoutExpression, viewportExpression } from "../layout/fastLayout.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError, DriverError } from "../core/errors.js";
import type { DeviceDriver, RawElement, Viewport } from "../drivers/types.js";
import { resolveAppSpace, toScreenRect } from "../layout/appSpace.js";

export type EvalConn = { evaluate(expr: string, opts?: { timeoutMs?: number }): Promise<any> };
export type LayoutSource = "js" | "os" | "auto";
/**
 * `source` is where the elements came from: the app runtime (`js`), the native
 * runner (`runner`), or the axe/uiautomator fallback (`os`). The input enum
 * `LayoutSource` is unchanged — `source: "os"` still means "not the JS path"
 * and the driver picks runner vs axe/adb.
 */
export type CapturedLayout = { els: Element[]; source: "js" | "os" | "runner"; note?: string; viewport?: Viewport };

const JS_LAYOUT_TIMEOUT_MS = 15000;

/**
 * The app measures in points/dp from the visible display frame; the driver
 * taps in its own units from the screen corner. Getting this wrong sends every
 * JS-resolved tap to the wrong place on Android (field test 3 D23) — so the
 * one conversion in src/layout/appSpace.ts is used, never a bare scale.
 */
export async function resolveViewport(
  driver: DeviceDriver,
  udid: string,
  conn?: EvalConn,
): Promise<Viewport | undefined> {
  if (conn) {
    try {
      const raw = await conn.evaluate(viewportExpression(), { timeoutMs: 5000 });
      const vp = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (vp && typeof vp.w === "number" && vp.w > 0) {
        return toScreenRect(vp as Viewport, await resolveAppSpace(driver, udid, { viewport: vp }));
      }
    } catch {
      /* fall through to the driver */
    }
  }
  const size = await driver.screenSize?.(udid).catch(() => undefined);
  return size ? { x: 0, y: 0, w: size.w, h: size.h } : undefined;
}

export async function captureLayoutWithSource(
  driver: DeviceDriver,
  udid: string,
  opts?: { conn?: EvalConn; source?: LayoutSource },
): Promise<CapturedLayout> {
  const source = opts?.source ?? "auto";
  if (source === "js" && !opts?.conn) {
    throw new UserInputError("JS layout unavailable: no active Metro connection.");
  }
  let note: string | undefined;
  if (source !== "os" && opts?.conn) {
    try {
      const raw = await opts.conn.evaluate(fastLayoutExpression(), { timeoutMs: JS_LAYOUT_TIMEOUT_MS });
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed?.available && Array.isArray(parsed.els) && parsed.els.length > 0) {
        // The overlay verdict is the one thing here the runtime cannot vouch
        // for (D38), so it alone pays for a fresh look at the window list —
        // the same single read that yields the origin.
        const space = await resolveAppSpace(driver, udid, { viewport: parsed.viewport, fresh: !!parsed.overlay });
        const phantom = !!parsed.overlay && space.overlayWindow === false;
        const rawEls = phantom ? withdrawOverlay(parsed.els as RawElement[]) : (parsed.els as RawElement[]);
        const els = toElements(rawEls.map((e) => toScreenRect(e, space)));
        const notes: string[] = [];
        if (parsed.truncated) notes.push(`truncated at ${els.length} elements`);
        // Reported, not silently applied: a tap that refuses with "covered by
        // another view" is only actionable if the response says what covers it.
        if (phantom) {
          notes.push(
            "the LogBox inspector is open in the JS state but its window is not on screen — its elements are marked hidden, the app is not covered",
          );
        } else if (parsed.overlay) {
          notes.push("a LogBox redbox covers the screen — everything under it is marked covered");
        }
        // Under a real redbox the toast is just one more covered thing.
        if ((phantom || !parsed.overlay) && Array.isArray(parsed.toasts)) {
          for (const t of parsed.toasts as (Viewport & { text?: string; covers?: number })[]) {
            const r = toScreenRect({ x: t.x, y: t.y, w: t.w, h: t.h }, space);
            const n = t.covers ?? 0;
            const under =
              n > 0 ? `${n} element${n === 1 ? "" : "s"} under it ${n === 1 ? "is" : "are"} marked covered; ` : "";
            notes.push(
              `a LogBox toast is on screen @${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)} ` +
                `(${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}: "${t.text ?? "LogBox toast"}") — ` +
                `${under}tap "Dismiss LogBox toast" to close it`,
            );
          }
        }
        return {
          els,
          source: "js",
          viewport: parsed.viewport ? toScreenRect(parsed.viewport as Viewport, space) : undefined,
          note: notes.length ? notes.join("; ") : undefined,
        };
      }
      // The expression reports *why* it found nothing; hiding that behind a
      // fixed string is what made a broken JS path look like an empty screen.
      note = `js layout unavailable: ${parsed?.error ?? "no measurable elements"}`;
      if (source === "js") throw new UserInputError(`JS layout unavailable: ${parsed?.error ?? "no measurable elements"}`);
    } catch (err) {
      if (source === "js") throw err;
      note = `js layout failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    const { els: raw, os } = await driver.rawLayout(udid);
    // The driver's own fallback reason ("runner starting") belongs next to the
    // JS one: both explain why this is not the fastest path.
    const reasons = [note, os.reason].filter((r): r is string => !!r);
    return {
      els: toElements(raw),
      source: os.path === "runner" ? "runner" : "os",
      note: reasons.length ? reasons.join("; ") : undefined,
    };
  } catch (err) {
    // No note means the JS path never ran (source: os) — the driver's error is
    // the only failure there is, so it must reach the caller unchanged.
    if (!note) throw err;
    // A note IS set: the JS path already failed. A DriverError's own
    // `.recommendation` (e.g. "use source:\"js\"") is only valid advice when
    // the JS path was never tried — folding it in here would send the caller
    // back to the path that just failed. Take the diagnosis alone (never the
    // recommendation) and supply a next step that is actually available when
    // both capture paths are down: screenshot / read_screen_text need neither.
    const diagnosis = err instanceof DriverError ? err.diagnosis : err instanceof Error ? err.message : String(err);
    throw new DriverError(
      `${note} — and the OS capture also failed: ${diagnosis} Both layout paths failed — ` +
        `use screenshot or read_screen_text to see the screen instead.`,
    );
  }
}

export async function captureLayout(
  driver: DeviceDriver,
  udid: string,
  opts?: { conn?: EvalConn; source?: LayoutSource },
): Promise<Element[]> {
  return (await captureLayoutWithSource(driver, udid, opts)).els;
}

export function layoutMarker(c: CapturedLayout): string {
  return `\n(layout: ${c.source}${c.note ? ` — ${c.note}` : ""})`;
}

export function registerLayoutTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  server.registerTool(
    "get_layout",
    {
      title: "Get layout",
      description:
        "Interactive on-screen elements with center coordinates. Elements scrolled out of view are listed separately as off-screen. Optional: filter with search terms (matched against text/testID), narrow by element type, or pass at:{x,y} to get the element at a point. source picks the capture path (js = app runtime, os = axe/uiautomator, default auto).",
      inputSchema: {
        search: z.array(z.string()).optional(),
        type: z.string().optional(),
        match: z.enum(["substring", "exact"]).optional(),
        case_sensitive: z.boolean().optional(),
        at: z.object({ x: z.number(), y: z.number() }).optional(),
        source: z.enum(["js", "os", "auto"]).optional(),
        device: z.string().optional(),
      },
    },
    async ({ search, type, match, case_sensitive, at, source, device }) => {
      try {
        if (search && at) throw new UserInputError("Use either `search` or `at`, not both.");
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        const captured = await captureLayoutWithSource(driver, udid, { conn, source });
        const marker = layoutMarker(captured);
        const els = captured.els;
        if (at) {
          const el = elementAtPoint(els, at.x, at.y);
          if (!el) return text(`No element at (${at.x}, ${at.y}).${marker}`);
          return text(
            `${el.text ?? el.testID ?? "?"}${el.type ? ` [${el.type}]` : ""} @${el.cx},${el.cy} (${el.x},${el.y} ${el.w}x${el.h})${el.offscreen ? " OFF-SCREEN" : ""}${marker}`,
          );
        }
        if (search || type) {
          const hits = searchElements(els, {
            search: search ?? [],
            type,
            match,
            caseSensitive: case_sensitive,
          });
          return text((hits.length ? formatLayout(hits, { listAll: true }) : "(no matching elements)") + marker);
        }
        return text(formatLayout(els) + marker);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
