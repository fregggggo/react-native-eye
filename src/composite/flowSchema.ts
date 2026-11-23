import { z } from "zod";
import { UserInputError } from "../core/errors.js";
import type { InputVia } from "../input/dispatch.js";

// Inner objects are strict too: a typo'd or unsupported key ({wait_for: {ms: 2000}},
// {tap: {testId: "x"}}) must be a loud validation error, not silently stripped.
const selector = z
  .object({
    text: z.string().optional(),
    testID: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

// Mirrors get_layout's `source`. The literals are checked against InputVia where
// a parsed step is handed to dispatchTap/dispatchType — if the two ever drift,
// that call stops compiling.
const viaEnum = z.enum(["js", "os", "auto"]);

// The tested app's search field carries a placeholder and no testID, so a
// testID-only target could not name it. Strict, so `testId` stays loud.
const inputTarget = z
  .object({
    testID: z.string().optional(),
    placeholder: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();

const stepSchema = z
  .object({
    tap: selector.extend({ duration_ms: z.number().optional(), via: viaEnum.optional() }).optional(),
    type: z
      .object({
        text: z.string(),
        // A bare string is the old spelling and still means {testID: <string>}.
        into: z.union([z.string(), inputTarget]).optional(),
        via: viaEnum.optional(),
      })
      .strict()
      .optional(),
    swipe: z
      .object({
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        x1: z.number().optional(),
        y1: z.number().optional(),
        x2: z.number().optional(),
        y2: z.number().optional(),
        duration_ms: z.number().optional(),
      })
      .strict()
      // D9: {swipe:{}} passed validation and reached `axe swipe` with undefined
      // coordinates, which replied with its own usage dump. The `swipe` tool
      // refuses the same input with this exact sentence — one input, one answer.
      // .strict() must be applied *before* .refine(): a refined schema is a
      // ZodEffects and no longer has .strict(), so reversing the order silently
      // drops unknown-key checking.
      .refine(
        (s) => s.direction !== undefined || [s.x1, s.y1, s.x2, s.y2].every((n) => typeof n === "number"),
        { message: "Provide a direction or x1,y1,x2,y2." },
      )
      .optional(),
    wait_for: z
      .object({
        text: z.string().optional(),
        testID: z.string().optional(),
        // `timeout` is the original spelling and stays valid; every other
        // duration in this schema ends in _ms, so agents reasonably write
        // timeout_ms and used to get a bare "Unrecognized key(s)" that read as
        // "the wait budget is not configurable". Both are accepted, and naming
        // both is an error rather than a silent winner. .strict() before
        // .refine() — see the swipe step for why the order matters.
        timeout: z.number().optional(),
        timeout_ms: z.number().optional(),
        exact: z.boolean().optional(),
      })
      .strict()
      .refine((w) => w.timeout === undefined || w.timeout_ms === undefined, {
        message: "wait_for takes either timeout_ms or timeout, not both.",
      })
      .optional(),
    // `exact`: the whole label, not a substring of it — "Row 1" is not "Row 12".
    expect: z
      .object({ text: z.string().optional(), testID: z.string().optional(), exact: z.boolean().optional() })
      .strict()
      .optional(),
    expect_not: z
      .object({ text: z.string().optional(), testID: z.string().optional(), exact: z.boolean().optional() })
      .strict()
      .optional(),
    eval: z.string().optional(),
    settle: z.number().optional(),
  })
  .strict();

export const ACTION_KEYS = ["tap", "type", "swipe", "wait_for", "expect", "expect_not", "eval"] as const;

/** The actions after which the runner settles — the only ones `settle` changes anything for. */
const INTERACTIONS = ["tap", "type", "swipe", "eval"];

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/**
 * Exactly one selector, and a usable one. `{expect_not: {}}` passed vacuously
 * (nothing matches nothing), `{tap: {text: ""}}` matched every label by
 * substring, and `{tap: {text, testID}}` silently used one and ignored the
 * other.
 */
function selectorProblem(key: string, sel: Record<string, unknown>): string | undefined {
  const hasX = sel.x !== undefined;
  const hasY = sel.y !== undefined;
  if (key === "tap" && hasX !== hasY) return "tap needs both x and y";
  const given = [
    nonEmpty(sel.text) && "text",
    nonEmpty(sel.testID) && "testID",
    key === "tap" && hasX && hasY && "x+y",
  ].filter((g): g is string => !!g);
  const allowed = key === "tap" ? "text, testID, or x+y" : "text or testID";
  if ((sel.text !== undefined && !nonEmpty(sel.text)) || (sel.testID !== undefined && !nonEmpty(sel.testID))) {
    return `${key} has an empty selector — give one non-empty ${allowed}`;
  }
  if (given.length === 0) return `${key} needs a selector: one of ${allowed}`;
  if (given.length > 1) return `${key} has ${given.length} selectors (${given.join(", ")}) — give exactly one of ${allowed}`;
  return undefined;
}

export type FlowStep = z.infer<typeof stepSchema>;

const flowSchema = z.object({ steps: z.array(stepSchema), via: viaEnum.optional() });

export type ParsedFlow = { steps: FlowStep[]; via?: InputVia };

export function actionKeysOf(step: FlowStep): string[] {
  return ACTION_KEYS.filter((k) => (step as Record<string, unknown>)[k] !== undefined);
}

export function parseFlowInput(input: unknown): ParsedFlow {
  const parsed = flowSchema.safeParse(input);
  if (!parsed.success) {
    throw new UserInputError(`Invalid flow: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  if (parsed.data.steps.length > 20) {
    throw new UserInputError("A flow may contain at most 20 steps. Split larger flows.");
  }
  // The runner is an if/else chain, so a step carrying two actions would execute
  // the first and silently drop the rest — {tap:…, expect:…} looked like a passing
  // assertion that never ran. One action per step, checked up front.
  parsed.data.steps.forEach((step, i) => {
    const keys = actionKeysOf(step);
    if (keys.length === 0) {
      throw new UserInputError(
        `Step ${i + 1} has no action. Each step needs exactly one of: ${ACTION_KEYS.join(", ")} (settle is a modifier).`,
      );
    }
    if (keys.length > 1) {
      throw new UserInputError(
        `Step ${i + 1} has ${keys.length} actions (${keys.join(", ")}). Split it into separate steps — one action each.`,
      );
    }
    const key = keys[0];
    if (step.settle !== undefined && !INTERACTIONS.includes(key)) {
      throw new UserInputError(
        `Step ${i + 1}: settle only applies after ${INTERACTIONS.join(", ")} — a ${key} step does not wait on it, so it would be ignored. Remove it.`,
      );
    }
    if (key === "tap" || key === "wait_for" || key === "expect" || key === "expect_not") {
      const problem = selectorProblem(key, (step as Record<string, Record<string, unknown>>)[key]);
      if (problem) throw new UserInputError(`Step ${i + 1}: ${problem}.`);
    }
  });
  return { steps: parsed.data.steps, via: parsed.data.via };
}

/** Steps only — one schema, one error path, and every existing caller unchanged. */
export function parseFlow(input: unknown): FlowStep[] {
  return parseFlowInput(input).steps;
}
