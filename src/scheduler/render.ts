// A cron expression in English, for the common forms. Anything else is shown as itself.

import { parseCron } from "./cron.ts";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// The phrase after "Runs:", or null when no common form fits.
export function cronPhrase(text: string): string | null {
  const cron = parseCron(text);
  const [minute, hour, day, month, weekday] = text.trim().split(/\s+/) as [string, string, string, string, string];
  if (month !== "*") return null;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && day === "*" && weekday === "*") {
    const n = Number(everyMinutes[1]);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  if (minute === "*" && hour === "*" && day === "*" && weekday === "*") return "every minute";
  if (!/^\d+$/.test(minute)) return null;
  const m = cron.minutes[0]!;
  if (hour === "*" && day === "*" && weekday === "*") return `every hour at :${String(m).padStart(2, "0")}`;
  if (!/^\d+$/.test(hour)) return null;
  const at = hhmm(cron.hours[0]!, m);
  if (day === "*" && weekday === "*") return `every day at ${at}`;
  if (day === "*") {
    const days = [...cron.weekdays].sort((a, b) => a - b);
    if (days.join() === "1,2,3,4,5") return `every weekday at ${at}`;
    return `every ${joinWords(days.map((d) => DAY_NAMES[d]!))} at ${at}`;
  }
  if (weekday === "*" && /^\d+$/.test(day)) return `on day ${day} of every month at ${at}`;
  return null;
}

export function scheduleSentence(cronText: string, timezone: string): string {
  const phrase = cronPhrase(cronText);
  return phrase ? `Runs: ${phrase} (${timezone}).` : `Runs on the schedule \`${cronText}\` (${timezone}).`;
}

export const MISSED_SENTENCES: Record<string, string> = {
  skip: "Missed runs are skipped.",
  run_once: "If runs are missed, the most recent one is made up once.",
  run_all: "Every missed run is made up.",
};
