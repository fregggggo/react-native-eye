import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runtimeContext } from "../tools/context.js";
import { captureLayout, resolveViewport } from "../tools/layout.js";
import { resolveTarget } from "../tools/interact.js";
import { isPresent, type Element } from "../layout/elements.js";
import { dispatchTap, dispatchType, osMarker, type InputVia } from "../input/dispatch.js";
import type { InputTarget } from "../input/text.js";
import { swipeVector, type Direction } from "../layout/gestures.js";
import { settleLayout } from "./settle.js";
import { parseFlowInput, actionKeysOf, type FlowStep } from "./flowSchema.js";
import { observeInternal } from "./observe.js";
import { toToolError, UserInputError } from "../core/errors.js";
import type { DeviceDriver } from "../drivers/types.js";

export type StepResult = {
  index: number;
  step: string;
  status: "ok" | "failed" | "aborted";
  detail?: string;
  /** `(input: js)` or `(input: os/<path>[ — <reasons>])` for steps that delivered input. */
  input?: string;
};

/**
 * The per-step line. Extracted from the tool handler so the marker can be
 * asserted without an McpServer: which steps went through JS and which paid for
 * a 17-25s touch is the whole reason the flow-level `via` exists.
 */
export function formatStepLine(r: StepResult): string {
  return `${r.index + 1}. ${r.step} — ${r.status}${r.input ? ` ${r.input}` : ""}${r.detail ? `: ${r.detail}` : ""}`;
}

type Deps = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Injected so the flow's own logic — via precedence, the report marker, the
  // snapshot cache — is testable without a device or a fiber tree.
  dispatchTap?: typeof dispatchTap;
  dispatchType?: typeof dispatchType;
};

function describeStep(step: FlowStep): string {
  const key = actionKeysOf(step)[0] ?? "unknown";
  return `${key}(${JSON.stringify((step as any)[key])})`;
}

/**
 * `into: "searchField"` is the old spelling and still means a testID. The object
 * form exists because the tested app's search field has a placeholder and no
 * testID, which made the testID-only parameter dead on a real app.
 */
function toInputTarget(into: string | InputTarget | undefined): InputTarget | undefined {
  return typeof into === "string" ? { testID: into } : into;
}

export type ObserveMode = "auto" | "full" | "none";

export async function runFlowInternal(
  steps: FlowStep[],
  opts?: { drivers?: DeviceDriver[]; device?: string; observe?: ObserveMode; via?: InputVia },
  deps?: Deps,
): Promise<{ results: StepResult[]; aborted?: string; observeContent: any[] }> {
  const { driver, udid, conn } = await runtimeContext(opts);
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps?.now ?? (() => Date.now());
  const doTap = deps?.dispatchTap ?? dispatchTap;
  const doType = deps?.dispatchType ?? dispatchType;
  const flowVia: InputVia = opts?.via ?? "auto";

  const results: StepResult[] = [];
  let aborted: string | undefined;
  // Snapshot cache: settle's layout feeds the next non-interacting step
  // (expect / resolve-by-text); any interaction invalidates it.
  let lastLayout: Element[] | undefined;
  let errWatermark = conn.errors.size() > 0 ? conn.errors.all()[conn.errors.size() - 1].seq : 0;
  // Once per flow, not per step: the interceptor follows the app's own later
  // setGlobalHandler by itself, so this only repairs a chain something tore
  // down outright since the last tool call (field test D26).
  await conn.installInterceptors("errors");

  const newError = async (): Promise<string | undefined> => {
    // A redbox raised by the app never reaches CDP, so the flow has to ask the
    // app for it — otherwise it keeps stepping through a covered screen and an
    // `expect` can even match the redbox's own text (field test D3).
    await conn.drainErrors().catch(() => {});
    const all = conn.errors.all();
    const fresh = all.filter((e) => e.seq > errWatermark);
    if (fresh.length) {
      errWatermark = fresh[fresh.length - 1].seq;
      return fresh[fresh.length - 1].text;
    }
    return undefined;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = describeStep(step);
    let inputMarker: string | undefined;
    try {
      const preErr = await newError();
      if (preErr) {
        aborted = preErr;
        results.push({ index: i, step: label, status: "aborted", detail: preErr });
        break;
      }

      let interaction = false;
      if (step.tap) {
        const t = step.tap;
        const { x, y } = await resolveTarget(driver, udid, t, { pre: lastLayout, conn });
        lastLayout = undefined;
        const d = await doTap({ driver, udid, x, y, durationMs: t.duration_ms, via: t.via ?? flowVia, conn });
        inputMarker = d.note ? `${d.marker} ${d.note}` : d.marker;
        interaction = true;
      } else if (step.type) {
        const t = step.type;
        lastLayout = undefined;
        const d = await doType({
          driver,
          udid,
          value: t.text,
          into: toInputTarget(t.into),
          via: t.via ?? flowVia,
          conn,
          // D2: axe typed "cat" under a Russian keyboard layout, the field
          // received "сф", and the tool reported success. A flow is the last
          // place that should pass unnoticed, so read-back verification is not
          // switchable off here.
          verify: true,
        });
        inputMarker = d.note ? `${d.marker} ${d.note}` : d.marker;
        interaction = true;
      } else if (step.swipe) {
        const s = step.swipe;
        const c = s.direction
          ? swipeVector(s.direction as Direction, await resolveViewport(driver, udid, conn))
          : [s.x1!, s.y1!, s.x2!, s.y2!];
        lastLayout = undefined;
        // Straight to the driver on purpose: the step has no `via`, and routing
        // through dispatchSwipe with the flow's via:"auto" would silently turn
        // the gesture into a JS scrollBy. The marker still names the OS path.
        inputMarker = osMarker(await driver.swipe(udid, c[0], c[1], c[2], c[3], s.duration_ms ?? 300));
        interaction = true;
      } else if (step.wait_for) {
        const timeout = step.wait_for.timeout_ms ?? step.wait_for.timeout ?? 3000;
        const start = now();
        let ok = false;
        let els = lastLayout ?? (await captureLayout(driver, udid, { conn }));
        while (true) {
          if (isPresent(els, step.wait_for)) {
            ok = true;
            break;
          }
          if (now() - start >= timeout) break;
          await sleep(50);
          els = await captureLayout(driver, udid, { conn });
        }
        if (!ok) throw new UserInputError(`wait_for timed out: ${JSON.stringify(step.wait_for)}`);
        lastLayout = els;
      } else if (step.expect) {
        const els = lastLayout ?? (await captureLayout(driver, udid, { conn }));
        lastLayout = els;
        if (!isPresent(els, step.expect)) {
          throw new UserInputError(`expect not met: ${JSON.stringify(step.expect)}`);
        }
      } else if (step.expect_not) {
        const els = lastLayout ?? (await captureLayout(driver, udid, { conn }));
        lastLayout = els;
        if (isPresent(els, step.expect_not)) {
          throw new UserInputError(`expect_not violated: ${JSON.stringify(step.expect_not)}`);
        }
      } else if (step.eval) {
        lastLayout = undefined;
        await conn.evaluate(step.eval);
        interaction = true;
      }

      if (interaction) {
        const settled = await settleLayout(
          driver,
          udid,
          step.settle !== undefined ? { fixedMs: step.settle, sleep, conn } : { sleep, now, conn },
        );
        lastLayout = settled.length ? settled : undefined;
      }

      const postErr = await newError();
      if (postErr) {
        aborted = postErr;
        results.push({ index: i, step: label, status: "aborted", detail: postErr, input: inputMarker });
        break;
      }

      results.push({ index: i, step: label, status: "ok", input: inputMarker });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ index: i, step: label, status: "failed", detail, input: inputMarker });
      break;
    }
  }

  // A full snapshot on every run was the flow's biggest cost: a one-step expect
  // came back with a screenshot and a few hundred layout lines. `auto` spends
  // that budget where it pays — on a run that did not do what was asked.
  const failed = !!aborted || results.some((r) => r.status !== "ok") || results.length < steps.length;
  const mode: ObserveMode = opts?.observe ?? "auto";
  if (mode === "none") return { results, aborted, observeContent: [] };
  const observe = await observeInternal(opts, {
    withScreenshot: true,
    withLayout: mode === "full" || failed,
  }).catch(() => ({ content: [] as any[] }));
  return { results, aborted, observeContent: observe.content };
}

export function registerRunFlowTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  server.registerTool(
    "run_flow",
    {
      title: "Run flow",
      description:
        "Run a sequence of UI steps server-side in one call (tap/type/swipe/wait_for/expect/expect_not/eval). Set via:'js' to dispatch taps and typing through the app's fiber tree instead of paying a simulator touch per step; each step's report line names the path it used. Aborts on the first failure or app error, and returns an observe snapshot at the stop point. Prefer this over many separate tap/observe calls.",
      inputSchema: {
        steps: z
          .array(z.record(z.any()))
          .describe(
            "Array of step objects, one action each, e.g. [{tap:{text:'Login'}},{expect:{text:'Home'}}]",
          ),
        device: z.string().optional(),
        observe: z
          .enum(["auto", "full", "none"])
          .optional()
          .describe(
            "Trailing snapshot: auto (default) = screenshot always, full layout only if the flow failed; full = both; none = neither.",
          ),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe(
            "Default input path for every tap/type step: js dispatches the press through the app's own fiber tree (~1ms), os delivers a real simulator touch (17-25s against a hot iOS app), auto tries js and falls back naming the reason. A step's own `via` wins. Default auto.",
          ),
      },
    },
    async (input) => {
      try {
        const { steps, via } = parseFlowInput(input);
        const { results, aborted, observeContent } = await runFlowInternal(steps, {
          ...opts,
          device: (input as { device?: string }).device,
          observe: (input as { observe?: ObserveMode }).observe,
          via,
        });
        const lines = results.map(formatStepLine);
        // Say what did not run, rather than leaving the tail of the flow unmentioned.
        for (let i = results.length; i < steps.length; i++) {
          lines.push(`${i + 1}. ${describeStep(steps[i])} — not run`);
        }
        const header = aborted
          ? `Flow ABORTED by app error: ${aborted}`
          : results.every((r) => r.status === "ok")
            ? "Flow completed."
            : "Flow stopped at a failed step.";
        return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }, ...observeContent] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
