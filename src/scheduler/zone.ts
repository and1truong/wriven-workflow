// Wall-clock arithmetic in an IANA zone. Lives in the engine process: Intl does not work under the
// run sandbox. Nothing here depends on the machine's own zone.

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, format);
  }
  return format;
}

// An IANA name, or UTC. Abbreviations such as AEST are refused even where the runtime knows them.
export function isValidZone(zone: string): boolean {
  if (zone !== "UTC" && !zone.includes("/")) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClock(instant: number, zone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

function offsetMs(instant: number, zone: string): number {
  const w = wallClock(instant, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

// The instant a wall-clock time stands for. A time that does not exist on a transition day runs at the
// first valid instant after it; a time that occurs twice runs at the first occurrence.
export function instantOf(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(asUtc - DAY_MS, zone);
  const after = offsetMs(asUtc + DAY_MS, zone);
  const candidates = before === after ? [asUtc - before] : [asUtc - Math.max(before, after), asUtc - Math.min(before, after)];
  for (const instant of candidates) {
    const w = wallClock(instant, zone);
    if (w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute) return instant;
  }
  // In the gap. Find the transition, to the second: the first instant with the later offset.
  let low = Math.floor((asUtc - DAY_MS) / 1000);
  let high = Math.floor((asUtc + DAY_MS) / 1000);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetMs(middle * 1000, zone) === before) low = middle;
    else high = middle;
  }
  return high * 1000;
}

export function toRfc3339(instant: number, zone: string): string {
  const w = wallClock(instant, zone);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offset = Math.round(offsetMs(instant, zone) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
