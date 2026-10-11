export function text(s: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: s }] };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}
