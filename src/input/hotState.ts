// Touch delivery against a "hot" RN app in the iOS simulator was measured at
// 17-29.8s per event, versus 1.4s for the same app backgrounded. Nothing here
// fixes that — the point is that the agent stops attributing the stall to its
// own selector, and learns the routes that are unaffected.
const SLOW_MS = 5_000;

const lastSlow = new Map<string, number>();
const announced = new Set<string>();

export function recordTouch(udid: string, ms: number): void {
  if (ms >= SLOW_MS) lastSlow.set(udid, ms);
}

export function hotNotice(udid: string): string | undefined {
  const ms = lastSlow.get(udid);
  if (ms === undefined || announced.has(udid)) return undefined;
  announced.add(udid);
  return (
    `Note: touch delivery on this app is currently slow (${Math.round(ms / 1000)}s for the last touch). ` +
    `This is a property of the app being foregrounded, not of the selector. ` +
    `Unaffected routes: via: "js" on tap/type_text/scroll_to, open_url for navigation, and screenshots.`
  );
}

/** Tests only. */
export function resetHotState(): void {
  lastSlow.clear();
  announced.clear();
}
