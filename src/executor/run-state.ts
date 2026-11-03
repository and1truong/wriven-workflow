// A stream's operational state inside a run: an in-memory copy of its dedupe keys, written to disk only
// when the run succeeds. A failed run commits nothing, so the next run sees the same items again.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { StepError } from "./messages.ts";

export interface StateFile {
  version: 1;
  // step id → key → when it was first seen (RFC 3339).
  seen: Record<string, Record<string, string>>;
}

export class RunState {
  private readonly data: StateFile;

  constructor(
    private readonly path: string | null,
    initial: StateFile | null,
  ) {
    this.data = initial ?? (path && existsSync(path) ? readState(path) : { version: 1, seen: {} });
  }

  // True when the key is new or has expired, and remembers it. Nothing reaches disk before commit.
  admit(stepId: string, key: string, now: Date, rememberMs: number): boolean {
    const seen = (this.data.seen[stepId] ??= {});
    const when = seen[key];
    if (when !== undefined && Date.parse(when) + rememberMs > now.getTime()) return false;
    seen[key] = now.toISOString();
    return true;
  }

  // Drops the oldest keys past the limit and everything expired.
  trim(stepId: string, now: Date, rememberMs: number, maxKeys: number): void {
    const seen = this.data.seen[stepId];
    if (!seen) return;
    const live = Object.entries(seen).filter(([, when]) => Date.parse(when) + rememberMs > now.getTime());
    live.sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.data.seen[stepId] = Object.fromEntries(live.slice(Math.max(0, live.length - maxKeys)));
  }

  get keyCount(): number {
    return Object.values(this.data.seen).reduce((sum, seen) => sum + Object.keys(seen).length, 0);
  }

  // Returns whether anything was written.
  commit(touched: boolean): boolean {
    if (!this.path || !touched) return false;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
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
