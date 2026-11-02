// Durations in the form <integer><unit>, with units s, m, h, d.

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNIT_WORD: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day" };

export const DURATION_PATTERN = "^[0-9]+[smhd]$";

export function parseDuration(text: string): number {
  const match = /^([0-9]+)([smhd])$/.exec(text);
  if (!match) throw new Error(`${text} is not a duration`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

export function durationWords(text: string): string {
  const match = /^([0-9]+)([smhd])$/.exec(text);
  if (!match) return text;
  const count = Number(match[1]);
  return `${count.toLocaleString("en-US")} ${UNIT_WORD[match[2]!]}${count === 1 ? "" : "s"}`;
}
