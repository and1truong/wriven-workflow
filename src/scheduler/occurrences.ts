// Which instants a cron expression fires at in a zone. Pure.

import { dayMatches, parseCron, type Cron } from "./cron.ts";
import { instantOf, wallClock } from "./zone.ts";

const DAY_MS = 86_400_000;
// Long enough to find any date that can occur at all, such as 29 February.
const MAX_DAYS_AHEAD = 366 * 8;

function firingsOn(cron: Cron, year: number, month: number, day: number, zone: string): number[] {
  const instants: number[] = [];
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) instants.push(instantOf(year, month, day, hour, minute, zone));
  }
  // Several wall-clock times can land on the same instant when clocks jump forward.
  return [...new Set(instants)].sort((a, b) => a - b);
}

// Calls `visit` with each firing after `after`, in order, until it returns false.
function walk(cron: Cron, zone: string, after: number, visit: (instant: number) => boolean): void {
  const start = wallClock(after, zone);
  // Noon, so stepping by whole days stays on the intended calendar day across transitions.
  let cursor = Date.UTC(start.year, start.month - 1, start.day, 12);
  let last = after;
  for (let i = 0; i < MAX_DAYS_AHEAD; i++, cursor += DAY_MS) {
    const date = new Date(cursor);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!dayMatches(cron, month, day, date.getUTCDay())) continue;
    for (const instant of firingsOn(cron, year, month, day, zone)) {
      if (instant <= last) continue;
      last = instant;
      if (!visit(instant)) return;
    }
  }
}

export function nextOccurrences(cron: Cron, zone: string, after: number, count: number): number[] {
  const out: number[] = [];
  walk(cron, zone, after, (instant) => {
    out.push(instant);
    return out.length < count;
  });
  return out;
}

// Firings in (after, until].
export function occurrencesBetween(cron: Cron, zone: string, after: number, until: number): number[] {
  const out: number[] = [];
  walk(cron, zone, after, (instant) => {
    if (instant > until) return false;
    out.push(instant);
    return true;
  });
  return out;
}

export { parseCron };
