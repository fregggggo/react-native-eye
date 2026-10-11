// Pairs `axe describe-ui` nodes with the runner's /viewHierarchy nodes on the
// same, still screen — by frame (±0.5pt) and label — and merges the resulting
// (XCUIElement.ElementType → axe type) pairs into
// test/fixtures/xcrunner/type-pairs.json. XC_TYPE_NAMES in
// src/layout/parseXcRunner.ts is then regenerated from that fixture.
//
// Capture one screen (hold the screen still; a moving feed pairs nothing):
//   npx tsx scripts/capture-xc-type-pairs.ts --udid <udid> --screen <name> [--port <runner port>]
// Regenerate the table from the fixture:
//   npx tsx scripts/capture-xc-type-pairs.ts --write-table
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { run, TIMEOUTS } from "../src/core/exec.js";
import { IosRunnerBackend } from "../src/native/iosBackend.js";
import { startIosRunner } from "../src/native/iosRunner.js";
import { XC_TYPE_NAMES } from "../src/layout/parseXcRunner.js";
import { SYSTEM_LABEL_RE } from "../src/layout/parseAxe.js";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/xcrunner/type-pairs.json", import.meta.url));
const SOURCE = fileURLToPath(new URL("../src/layout/parseXcRunner.ts", import.meta.url));
const TOLERANCE = 0.5;

export type Pair = { elementType: number; axeType: string; count: number };
export type PairFixture = { meta: { screens: string[]; device?: string; updatedAt: string }; pairs: Pair[] };
export type Flat = { x: number; y: number; w: number; h: number; key: string; labelled: boolean; type: string | number };

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function flat(
  x: unknown, y: unknown, w: unknown, h: unknown,
  label: unknown, id: unknown, value: unknown, type: string | number,
): Flat | undefined {
  const [fx, fy, fw, fh] = [n(x), n(y), n(w), n(h)];
  if (fx === undefined || fy === undefined || fw === undefined || fh === undefined || fw <= 0 || fh <= 0) return undefined;
  // Only nodes carrying a label, identifier or value are ever emitted as
  // elements by parseAxe / parseXcRunner, so only their type names matter —
  // and unlabelled containers stacked on one frame would pair at random.
  // Scroll bars are dropped by both parsers too (SYSTEM_LABEL_RE); XCUI calls
  // them Other (1) while axe calls them Slider, so letting them vote would
  // outvote GenericElement for type 1 on any screen with a scroll view.
  return {
    x: fx, y: fy, w: fw, h: fh,
    key: `${s(label)}\u0000${s(id)}`,
    labelled: !!(s(label) || s(id) || s(value)) && !SYSTEM_LABEL_RE.test(s(label)),
    type,
  };
}

/** axe describe-ui: an array of AX nodes with lowercase frames and a string `type`. */
export function flattenAxe(nodes: unknown): Flat[] {
  const out: Flat[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    const fr = node.frame ?? {};
    if (typeof node.type === "string") {
      const e = flat(fr.x, fr.y, fr.width, fr.height, node.AXLabel, node.AXIdentifier, node.AXValue, node.type);
      if (e) out.push(e);
    }
    for (const c of Array.isArray(node.children) ? node.children : []) visit(c);
  };
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) visit(node);
  return out;
}

/** The runner's {axElement, depth}: capitalised frames and a numeric `elementType`. */
export function flattenRunner(json: unknown): Flat[] {
  const out: Flat[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    const fr = node.frame ?? {};
    if (typeof node.elementType === "number") {
      const e = flat(fr.X, fr.Y, fr.Width, fr.Height, node.label, node.identifier, node.value, node.elementType);
      if (e) out.push(e);
    }
    for (const c of Array.isArray(node.children) ? node.children : []) visit(c);
  };
  visit((json as any)?.axElement ?? json);
  return out;
}

const sameFrame = (a: Flat, b: Flat): boolean =>
  Math.abs(a.x - b.x) <= TOLERANCE &&
  Math.abs(a.y - b.y) <= TOLERANCE &&
  Math.abs(a.w - b.w) <= TOLERANCE &&
  Math.abs(a.h - b.h) <= TOLERANCE;

/** A pair only when each side has exactly one labelled candidate on the other. */
export function pairNodes(axe: Flat[], runner: Flat[]): { elementType: number; axeType: string }[] {
  const out: { elementType: number; axeType: string }[] = [];
  const A = axe.filter((a) => a.labelled);
  const R = runner.filter((r) => r.labelled);
  for (const r of R) {
    const cands = A.filter((a) => a.key === r.key && sameFrame(a, r));
    if (cands.length !== 1) continue;
    const back = R.filter((r2) => r2.key === cands[0].key && sameFrame(cands[0], r2));
    if (back.length !== 1) continue;
    out.push({ elementType: r.type as number, axeType: cands[0].type as string });
  }
  return out;
}

export function mergePairs(
  fixture: PairFixture | undefined,
  found: { elementType: number; axeType: string }[],
  screen: string,
  device?: string,
): PairFixture {
  const counts = new Map<string, Pair>();
  for (const p of fixture?.pairs ?? []) counts.set(`${p.elementType}|${p.axeType}`, { ...p });
  for (const p of found) {
    const k = `${p.elementType}|${p.axeType}`;
    const cur = counts.get(k);
    if (cur) cur.count += 1;
    else counts.set(k, { elementType: p.elementType, axeType: p.axeType, count: 1 });
  }
  const screens = [...(fixture?.meta.screens ?? [])];
  if (!screens.includes(screen)) screens.push(screen);
  return {
    meta: { screens, device: device ?? fixture?.meta.device, updatedAt: new Date().toISOString() },
    pairs: [...counts.values()].sort((a, b) => a.elementType - b.elementType || b.count - a.count),
  };
}

/** The axe type each elementType pairs with most often. */
export function dominantTypes(fx: PairFixture): Map<number, Pair> {
  const best = new Map<number, Pair>();
  for (const p of fx.pairs) {
    const cur = best.get(p.elementType);
    if (!cur || p.count > cur.count) best.set(p.elementType, p);
  }
  return best;
}

function readFixture(): PairFixture | undefined {
  return existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as PairFixture) : undefined;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function capture(udid: string, screen: string, port?: number): Promise<void> {
  const runnerPort = port ?? (await startIosRunner(udid)).port;
  const backend = new IosRunnerBackend(runnerPort);
  const hierarchy = await backend.hierarchy();
  const { stdout } = await run("axe", ["describe-ui", "--udid", udid], { timeoutMs: TIMEOUTS.layout });
  const axe = flattenAxe(JSON.parse(stdout));
  const runner = flattenRunner(hierarchy);
  const found = pairNodes(axe, runner);
  const merged = mergePairs(readFixture(), found, screen, udid);
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(merged, null, 2)}\n`);
  const kinds = new Map<string, number>();
  for (const p of found) kinds.set(`${p.elementType} → ${p.axeType}`, (kinds.get(`${p.elementType} → ${p.axeType}`) ?? 0) + 1);
  console.log(`screen "${screen}": axe ${axe.length} nodes, runner ${runner.length} nodes, ${found.length} pairs`);
  for (const [k, c] of [...kinds].sort()) console.log(`  ${k} ×${c}`);
  console.log(`fixture: ${merged.pairs.length} distinct pairs over ${merged.meta.screens.length} screens`);
}

function writeTable(): void {
  const fx = readFixture();
  if (!fx) throw new Error(`${FIXTURE} does not exist — capture at least one screen first.`);
  const dom = dominantTypes(fx);
  const merged: Record<number, string> = { ...XC_TYPE_NAMES };
  for (const [t, p] of dom) merged[t] = p.axeType;
  const conflicts = new Map<number, Pair[]>();
  for (const p of fx.pairs) conflicts.set(p.elementType, [...(conflicts.get(p.elementType) ?? []), p]);
  const lines = Object.keys(merged)
    .map(Number)
    .sort((a, b) => a - b)
    .map((t) => {
      const p = dom.get(t);
      const note = p ? ` // axe, paired ×${p.count}` : "";
      return `  ${t}: ${JSON.stringify(merged[t])},${note}`;
    });
  const block =
    "// BEGIN XC_TYPE_NAMES (generated by scripts/capture-xc-type-pairs.ts --write-table)\n" +
    `export const XC_TYPE_NAMES: Record<number, string> = {\n${lines.join("\n")}\n};\n` +
    "// END XC_TYPE_NAMES";
  const src = readFileSync(SOURCE, "utf8");
  const re = /\/\/ BEGIN XC_TYPE_NAMES[\s\S]*?\/\/ END XC_TYPE_NAMES/;
  if (!re.test(src)) throw new Error(`${SOURCE} has no BEGIN/END XC_TYPE_NAMES markers.`);
  writeFileSync(SOURCE, src.replace(re, block));
  console.log(`rewrote XC_TYPE_NAMES: ${dom.size} types from pairs, ${Object.keys(merged).length} total`);
  for (const [t, ps] of conflicts) {
    if (ps.length > 1) {
      console.log(`  conflict: elementType ${t} → ${ps.map((p) => `${p.axeType} ×${p.count}`).join(", ")} (majority kept)`);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--write-table")) return writeTable();
  const udid = arg("udid");
  const screen = arg("screen");
  if (!udid || !screen) {
    console.error("usage: --udid <udid> --screen <name> [--port <runner port>]  |  --write-table");
    process.exit(2);
  }
  const port = arg("port") ? Number(arg("port")) : undefined;
  await capture(udid, screen, port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
