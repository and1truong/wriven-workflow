// Five-field cron: minute hour day-of-month month day-of-week. Lists, ranges, steps, names. No seconds,
// no aliases, no L/W/#. Day-of-month and day-of-week combine with OR when both are restricted.

export interface Cron {
  text: string;
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function value(token: string, min: number, max: number, names: string[] | null, nameBase: number, field: string): number {
  const named = names?.indexOf(token.toUpperCase()) ?? -1;
  const number = named !== -1 ? named + nameBase : /^[0-9]+$/.test(token) ? Number(token) : NaN;
  if (Number.isNaN(number) || number < min || number > max) throw new Error(`"${token}" is not valid in the ${field} field.`);
  return number;
}

function parseField(text: string, min: number, max: number, names: string[] | null, nameBase: number, field: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "") throw new Error(`"${part}" is not valid in the ${field} field.`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^[1-9][0-9]*$/.test(stepText)) throw new Error(`"${part}" has an invalid step in the ${field} field.`);
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new Error(`"${part}" is not valid in the ${field} field.`);
      low = value(a, min, max, names, nameBase, field);
      high = value(b, min, max, names, nameBase, field);
      if (high < low) throw new Error(`"${part}" runs backwards in the ${field} field.`);
    } else {
      low = value(range, min, max, names, nameBase, field);
      high = stepText !== undefined ? max : low;
    }
    for (let v = low; v <= high; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(text: string): Cron {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`A schedule has five fields; "${text}" has ${fields.length}.`);
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, 0, 7, WEEKDAYS, 0, "day-of-week").map((d) => d % 7);
  return {
    text,
    minutes: parseField(minute, 0, 59, null, 0, "minute"),
    hours: parseField(hour, 0, 23, null, 0, "hour"),
    days: new Set(parseField(day, 1, 31, null, 0, "day-of-month")),
    months: new Set(parseField(month, 1, 12, MONTHS, 1, "month")),
    weekdays: new Set(weekdays),
    dayRestricted: !day.startsWith("*"),
    weekdayRestricted: !weekday.startsWith("*"),
  };
}

export function dayMatches(cron: Cron, month: number, day: number, weekday: number): boolean {
  if (!cron.months.has(month)) return false;
  const byDay = cron.days.has(day);
  const byWeekday = cron.weekdays.has(weekday);
  if (cron.dayRestricted && cron.weekdayRestricted) return byDay || byWeekday;
  return byDay && byWeekday;
}

// On a day it matches, how many times it fires. Daylight saving moves a run but adds none.
export function occurrencesPerDay(cron: Cron): number {
  return cron.minutes.length * cron.hours.length;
}
