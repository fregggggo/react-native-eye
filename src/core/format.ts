export function text(s: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: s }] };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/**
 * Appended when an answer comes from the record of a connection that is gone:
 * what was captured is still true, but nothing newer can arrive.
 */
export function lostNote(lost: string | undefined): string {
  return lost
    ? `\n(note: not connected — ${lost}. This is what was captured before the connection dropped; nothing newer is in it.)`
    : "";
}
