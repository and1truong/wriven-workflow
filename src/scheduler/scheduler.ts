// The engine's own clock, active only with `clock: engine`. Each stream with a `schedule` input has a
// bookmark, `last_handled`, that survives restarts; everything else is arithmetic against it.

import { join } from "node:path";
import { logLine } from "../log.ts";
import { readJson, writeJsonAtomic } from "../state/files.ts";
import type { Manifest, StreamStore } from "../state/streams.ts";
import { nextOccurrences, occurrencesBetween, parseCron } from "./occurrences.ts";
import { toRfc3339 } from "./zone.ts";

// A run about to fire when the engine stopped is not counted as missed.
export const GRACE_MS = 30_000;
const MAX_SLEEP_MS = 60_000;

export interface SchedulerDeps {
  now(): Date;
  streams: StreamStore;
  enqueue(manifest: Manifest, scheduledFor: string): void;
}

function isScheduled(manifest: Manifest): boolean {
  return manifest.pipeline.input.type === "schedule";
}

export class Scheduler {
  private timer: Timer | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.tick();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  // Applies the policy to everything due. Called by the timer, and directly by tests.
  tick(): void {
    const now = this.deps.now().getTime();
    for (const manifest of this.deps.streams.all()) {
      if (manifest.status !== "active" || !isScheduled(manifest)) continue;
      // One stream's failure must not stop the others'.
      try {
        const last = this.lastHandled(manifest);
        if (last === null) {
          this.setLastHandled(manifest.stream_id, now);
          continue;
        }
        this.handleStream(manifest, last, now);
      } catch (err) {
        logLine("error", "the scheduler failed on a stream", { stream_id: manifest.stream_id, error: String(err) });
      }
    }
  }

  // A stream just became runnable (approved or resumed): nothing before now is made up.
  markActivated(manifest: Manifest): void {
    if (isScheduled(manifest)) this.setLastHandled(manifest.stream_id, this.deps.now().getTime());
    this.arm();
  }

  nextRun(manifest: Manifest): string | null {
    if (manifest.status !== "active" || !isScheduled(manifest)) return null;
    const { cron, timezone } = manifest.pipeline.input;
    const [next] = nextOccurrences(parseCron(cron), timezone, this.deps.now().getTime(), 1);
    return next === undefined ? null : toRfc3339(next, timezone);
  }

  private handleStream(manifest: Manifest, last: number, now: number): void {
    const { cron, timezone, missed = "run_once" } = manifest.pipeline.input;
    const firings = occurrencesBetween(parseCron(cron), timezone, last, now);
    if (firings.length === 0) return;
    const overdue = firings.filter((t) => t <= now - GRACE_MS);
    const due = firings.filter((t) => t > now - GRACE_MS);
    const madeUp = missed === "skip" ? [] : missed === "run_once" ? overdue.slice(-1) : overdue;
    // Handled when enqueued, not when finished: a run that fails is not retried, the next occurrence is.
    this.setLastHandled(manifest.stream_id, firings.at(-1)!);
    for (const instant of [...madeUp, ...due]) this.deps.enqueue(manifest, toRfc3339(instant, timezone));
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.deps.now().getTime();
    let wait = MAX_SLEEP_MS;
    for (const manifest of this.deps.streams.all()) {
      if (manifest.status !== "active" || !isScheduled(manifest)) continue;
      const { cron, timezone } = manifest.pipeline.input;
      const [next] = nextOccurrences(parseCron(cron), timezone, now, 1);
      if (next !== undefined) wait = Math.min(wait, Math.max(next - now, 0));
    }
    // Never long: a machine that slept shows up as `now` jumping on the next look.
    this.timer = setTimeout(() => {
      try {
        this.tick();
      } catch (err) {
        logLine("error", "the scheduler failed", { error: String(err) });
      }
      this.arm();
    }, wait + 1);
  }

  private bookmarkPath(streamId: string): string {
    return join(this.deps.streams.dir(streamId), "schedule.json");
  }

  private lastHandled(manifest: Manifest): number | null {
    try {
      const bookmark = readJson<{ last_handled: string }>(this.bookmarkPath(manifest.stream_id));
      const instant = bookmark ? Date.parse(bookmark.last_handled) : NaN;
      return Number.isNaN(instant) ? null : instant;
    } catch {
      // Unreadable counts as no bookmark: nothing is made up, the next occurrence fires.
      return null;
    }
  }

  private setLastHandled(streamId: string, instant: number): void {
    writeJsonAtomic(this.bookmarkPath(streamId), { last_handled: new Date(instant).toISOString() });
  }
}
