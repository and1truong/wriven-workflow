// One run at a time per engine. Triggers wait in order; a queued trigger for the same stream collapses
// into one. A run that finished is remembered for a while so `run.cancel` stays idempotent.

import { RpcError } from "../protocol/errors.ts";
import type { ReportError, RunReport, RunTrigger } from "../report.ts";
import { RunProcess, skippedOrCancelledReport, type RunJob, type SupervisorEnv } from "../supervisor/supervisor.ts";
import { logLine } from "../log.ts";
import type { Manifest } from "../state/streams.ts";

const FINISHED_REMEMBERED = 1000;

interface Queued {
  job: RunJob;
  collapsible: boolean;
}

export interface TriggerOptions {
  trigger: RunTrigger;
  scheduled_for: string | null;
  collapsible: boolean;
}

export interface QueueEnv extends SupervisorEnv {
  emitFinished(report: RunReport): void;
}

export class RunQueue {
  private readonly waiting: Queued[] = [];
  private current: { process: RunProcess; finished: Promise<void> } | null = null;
  private readonly finished = new Map<string, RunReport["status"]>();
  private stopped = false;

  constructor(private readonly env: QueueEnv) {}

  enqueue(manifest: Manifest, options: TriggerOptions): { run_id: string; status: "queued" } {
    if (options.collapsible) {
      const same = this.waiting.find((q) => q.collapsible && q.job.stream_id === manifest.stream_id);
      if (same) return { run_id: same.job.run_id, status: "queued" };
    }
    const job: RunJob = {
      run_id: Bun.randomUUIDv7(),
      stream_id: manifest.stream_id,
      stream_name: manifest.name,
      pipeline: manifest.pipeline,
      permissions_hash: manifest.permissions_hash,
      trigger: options.trigger,
      scheduled_for: options.scheduled_for,
      queued_at: this.env.now().toISOString(),
      clock: null,
      input_override: null,
    };
    this.waiting.push({ job, collapsible: options.collapsible });
    setTimeout(() => this.pump(), 0);
    return { run_id: job.run_id, status: "queued" };
  }

  cancel(runId: string): { run_id: string; status: string } {
    const known = this.finished.get(runId);
    if (known) return { run_id: runId, status: known };
    if (this.current?.process.job.run_id === runId) {
      this.current.process.cancel("run_cancel");
      return { run_id: runId, status: "cancelling" };
    }
    const index = this.waiting.findIndex((q) => q.job.run_id === runId);
    if (index === -1) throw new RpcError("not_found", `There is no run with the id ${runId}.`);
    const [queued] = this.waiting.splice(index, 1);
    this.finishUnstarted(queued!.job, "run_cancel");
    return { run_id: runId, status: "cancelled" };
  }

  // Queued triggers for the stream are cancelled. The running run continues unless `stopRunning`.
  async cancelStream(streamId: string, reason: string, stopRunning: boolean): Promise<void> {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i]!.job.stream_id === streamId) {
        const [queued] = this.waiting.splice(i, 1);
        this.finishUnstarted(queued!.job, reason);
      }
    }
    if (stopRunning && this.current?.process.job.stream_id === streamId) {
      this.current.process.cancel(reason);
      await this.current.finished;
    }
  }

  // Stops accepting work: queued runs are cancelled; the running one gets `timeoutMs` to finish.
  async drain(timeoutMs: number): Promise<void> {
    this.stopped = true;
    while (this.waiting.length > 0) this.finishUnstarted(this.waiting.shift()!.job, "shutdown");
    const current = this.current;
    if (!current) return;
    const timer = setTimeout(() => {
      current.process.killWith({
        status: "cancelled",
        error: { kind: "cancelled", message: "The engine shut down before the run finished.", step_id: null, message_id: null, retry_after: null, reason: "killed_after_timeout" },
      });
    }, timeoutMs);
    await current.finished;
    clearTimeout(timer);
  }

  get stopping(): boolean {
    return this.stopped;
  }

  private finishUnstarted(job: RunJob, reason: string): void {
    const error: ReportError = { kind: "cancelled", message: `The run was cancelled before it started (${reason}).`, step_id: null, message_id: null, retry_after: null, reason };
    this.emit(skippedOrCancelledReport(job, this.env.now(), "cancelled", error));
  }

  private emit(report: RunReport): void {
    this.finished.set(report.run_id, report.status);
    if (this.finished.size > FINISHED_REMEMBERED) this.finished.delete(this.finished.keys().next().value!);
    this.env.emitFinished(report);
  }

  private pump(): void {
    if (this.current || this.stopped) return;
    const next = this.waiting.shift();
    if (!next) return;
    const process = new RunProcess(next.job, this.env);
    const finished = process
      .run()
      .then((report) => this.emit(report))
      .catch((err) => logLine("error", "a run failed outside the supervisor", { error: String(err), run_id: next.job.run_id }))
      .finally(() => {
        this.current = null;
        this.pump();
      });
    this.current = { process, finished };
  }
}
