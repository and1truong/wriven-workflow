// A stream's operational state inside a run: an in-memory copy of its dedupe keys, written to disk only
// when the run succeeds. A failed run commits nothing, so the next run sees the same items again.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeDurably } from "../state/files.ts";
import { StepError } from "./messages.ts";

export interface StateFile {
  version: 1;
  // step id → key → when it was first seen (RFC 3339).
  seen: Record<string, Record<string, string>>;
}

export class RunState {
  // Maps: keys come from feeds, and a guid named __proto__ is just a key.
  private readonly seen = new Map<string, Map<string, string>>();

  constructor(
    private readonly path: string | null,
    initial: StateFile | null,
  ) {
    const file = initial ?? (path && existsSync(path) ? readState(path) : { version: 1 as const, seen: {} });
    for (const [stepId, keys] of Object.entries(file.seen)) this.seen.set(stepId, new Map(Object.entries(keys)));
  }

  // True when the key is new or has expired, and remembers it. Nothing reaches disk before commit.
  admit(stepId: string, key: string, now: Date, rememberMs: number): boolean {
    let seen = this.seen.get(stepId);
    if (!seen) {
      seen = new Map();
      this.seen.set(stepId, seen);
    }
    const when = seen.get(key);
    if (when !== undefined && Date.parse(when) + rememberMs > now.getTime()) return false;
    seen.set(key, now.toISOString());
    return true;
  }

  // Drops the oldest keys past the limit and everything expired.
  trim(stepId: string, now: Date, rememberMs: number, maxKeys: number): void {
    const seen = this.seen.get(stepId);
    if (!seen) return;
    const live = [...seen].filter(([, when]) => Date.parse(when) + rememberMs > now.getTime());
    live.sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.seen.set(stepId, new Map(live.slice(Math.max(0, live.length - maxKeys))));
  }

  get keyCount(): number {
    let count = 0;
    for (const seen of this.seen.values()) count += seen.size;
    return count;
  }

  // Returns whether anything was written.
  commit(touched: boolean): boolean {
    if (!this.path || !touched) return false;
    const tmp = `${this.path}.tmp`;
    const seen = Object.fromEntries([...this.seen].map(([stepId, keys]) => [stepId, Object.fromEntries(keys)]));
    writeDurably(tmp, `${JSON.stringify({ version: 1, seen } satisfies StateFile)}\n`);
    renameSync(tmp, this.path);
    return true;
  }
}

function readState(path: string): StateFile {
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new StepError("state_invalid", `The stream's state file cannot be read: ${(err as Error).message}`);
  }
  if (parsed?.version !== 1 || typeof parsed.seen !== "object" || parsed.seen === null) {
    throw new StepError("state_invalid", "The stream's state file is not in a known format.");
  }
  return parsed as StateFile;
}
