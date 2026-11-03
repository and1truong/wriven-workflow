// The `serve` process: handshake, method table and lifecycle. Business logic lives in the modules it
// calls; this file decides what is allowed when.

import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { publicComponents } from "../components/definitions.ts";
import { logLine, type LogLevel } from "../log.ts";
import { effectiveCeilings, type Ceilings } from "../pipeline/ceilings.ts";
import { DURATION_PATTERN, parseDuration } from "../pipeline/duration.ts";
import { DEFAULT_DISPLAY_NAME, renderPermissions } from "../pipeline/render.ts";
import { canonicalJson } from "../pipeline/canonical.ts";
import { REPORT_SCHEMA } from "../report.ts";
import { pipelineSchema } from "../pipeline/schema.ts";
import { CONDITION_DOC } from "../pipeline/condition.ts";
import { isSubset, sentenceDiff } from "../pipeline/subset.ts";
import { validatePipeline, type ValidationContext } from "../pipeline/validate.ts";
import { RpcError } from "../protocol/errors.ts";
import { Peer, type RequestContext } from "../protocol/peer.ts";
import { selfCommand } from "../self.ts";
import { newStreamId, StreamStore, type Manifest, type PinnedPipeline, type PreviousManifest } from "../state/streams.ts";
import { ENGINE_NAME, ENGINE_VERSION, PIPELINE_FORMATS, PROTOCOL_VERSIONS, REPORT_VERSION } from "../version.ts";
import { checkExpectations, runPipelineTest, type EmbeddedTest, type TestParams } from "../harness/pipeline-test.ts";
import type { RunProcess } from "../supervisor/supervisor.ts";
import { HOST_TOOLS_SUGGESTED, TOOLS, withToolResult } from "../tools/tools.ts";
import { truncateResult } from "../tools/truncate.ts";
import { parseCron } from "../scheduler/cron.ts";
import { nextOccurrences } from "../scheduler/occurrences.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { isValidZone, toRfc3339 } from "../scheduler/zone.ts";
import { tryLock } from "./lock.ts";
import { RunQueue } from "./run-queue.ts";
import { probeSandbox, type SandboxStatus } from "../supervisor/seatbelt.ts";
import type { SupervisorEnv } from "../supervisor/supervisor.ts";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_HOST_RESPONSE_MS = 120_000;
const MAX_REPORT_BYTES = 3 * 1024 * 1024;

export interface EngineOptions {
  write(line: string): void;
  exit(code: number): void;
  onLine?(direction: "in" | "out", line: string): void;
  now?(): Date;
  // Argv prefix that re-executes the binary; tests running in-process point it at the compiled one.
  command?: string[];
  // Only tests in this repository set these.
  test?: SupervisorEnv["test"] & { memorySampleMs?: number; noSchedulerTimer?: boolean; noSandbox?: boolean };
}

export class Engine {
  readonly peer: Peer;
  private initialized = false;
  private context!: ValidationContext;
  private releaseLock: (() => void) | null = null;
  private stopping: Promise<void> | null = null;
  private streams!: StreamStore;
  private sandbox!: SandboxStatus;
  private sandboxRequired = true;
  private queue!: RunQueue;
  private readonly now: () => Date;
  private supervisorEnv!: SupervisorEnv;
  private scheduler: Scheduler | null = null;
  private liveNetworkInTests = false;
  private readonly activeTests = new Set<RunProcess>();
  private readonly testsFinished = new Set<Promise<unknown>>();

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.peer = new Peer({
      write: options.write,
      idPrefix: "e-",
      onLine: options.onLine,
      onRequest: (method, params, ctx) => this.dispatch(method, params, ctx),
    });
  }

  // Runs the scheduler now, for tests on a fake clock.
  tickScheduler(): void {
    this.scheduler?.tick();
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    logLine(level, msg, fields);
    if (this.initialized) this.peer.notify("log", { level, msg, ...fields });
  }

  // The host closed our stdin: same as `shutdown` with the default timeout, but nobody is left to
  // answer, so requests to the host fail at once rather than wait out the timeout.
  async onStdinClosed(): Promise<void> {
    this.peer.close(new RpcError("cancelled", "The host closed the connection.", { reason: "host_gone" }));
    await this.stop(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.options.exit(0);
  }

  private async dispatch(method: string, params: any, ctx: RequestContext): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    if (!this.initialized) {
      throw new RpcError("not_initialized", `The engine must be initialized before ${method}.`);
    }
    return withToolResult(method, await this.call(method, params, ctx));
  }

  private call(method: string, params: any, ctx: RequestContext): unknown {
    switch (method) {
      case "components.list":
        return this.listComponents(params);
      case "pipeline.validate":
        return this.validate(params);
      case "pipeline.test":
        return this.testPipeline(params, ctx);
      case "stream.create":
        return this.createStream(params);
      case "stream.approve":
        return this.approveStream(params);
      case "stream.update":
        return this.updateStream(params);
      case "stream.pause":
        return this.pauseStream(params);
      case "stream.resume":
        return this.resumeStream(params);
      case "stream.delete":
        return this.deleteStream(params);
      case "stream.list":
        return { streams: this.streams.all().map((m) => this.streamRow(m)) };
      case "stream.get":
        return this.getStream(params);
      case "schedule.preview":
        return previewSchedule(params);
      case "run.trigger":
        return this.triggerRun(params);
      case "run.cancel":
        return this.queue.cancel(requireString(params, "run_id"));
      case "shutdown":
        return this.shutdown(params);
      default:
        throw new RpcError("method_not_found", `There is no method named ${method}.`);
    }
  }

  private initialize(params: any): unknown {
    if (params?.protocol_version === undefined || !PROTOCOL_VERSIONS.includes(params.protocol_version)) {
      throw new RpcError("unsupported_version", `This engine speaks protocol versions ${PROTOCOL_VERSIONS.join(", ")}.`, {
        supported: PROTOCOL_VERSIONS,
      });
    }
    if (this.initialized) {
      throw new RpcError("conflict", "The engine is already initialized.", { reason: "already_initialized" });
    }
    if (params.clock !== "host" && params.clock !== "engine") {
      throw new RpcError("invalid_params", 'clock must be "host" or "engine".', { reason: "invalid_clock" });
    }
    if (params.sandbox !== undefined && params.sandbox !== "required" && params.sandbox !== "optional") {
      throw new RpcError("invalid_params", 'sandbox must be "required" or "optional".', { reason: "invalid_sandbox" });
    }
    const ceilings: Ceilings = effectiveCeilings(params.ceilings);
    const hostResponseMs = readDuration(params.timeouts?.host_response, DEFAULT_HOST_RESPONSE_MS, "timeouts.host_response");
    const stateDir = checkStateDir(params.state_dir);
    const release = tryLock(join(stateDir, "engine.lock"));
    if (!release) {
      throw new RpcError("conflict", "Another engine holds the lock on this state directory.", { reason: "engine_lock_held" });
    }
    this.releaseLock = release;
    try {
      return this.setUp(params, stateDir, ceilings, hostResponseMs);
    } catch (err) {
      this.releaseLock = null;
      release();
      throw err;
    }
  }

  private setUp(params: any, stateDir: string, ceilings: Ceilings, hostResponseMs: number): unknown {
    mkdirSync(join(stateDir, "streams"), { recursive: true, mode: 0o700 });
    // Left behind if an earlier engine died mid-run. We hold the lock, so nothing is using it.
    rmSync(join(stateDir, "run-tmp"), { recursive: true, force: true });
    this.sandbox = this.options.test?.noSandbox ? { available: false, path: null, reason: "Disabled for this test." } : probeSandbox();
    this.sandboxRequired = params.sandbox !== "optional";
    const sandboxAvailable = this.sandbox.available;
    const capabilities = params.capabilities ?? {};
    this.context = {
      clock: params.clock,
      capabilities: { llm: capabilities.llm === true, results: capabilities.results === true },
      ceilings,
      displayName: typeof params.host?.display_name === "string" && params.host.display_name !== "" ? params.host.display_name : DEFAULT_DISPLAY_NAME,
      sandboxAvailable,
      llmReportsCost: capabilities.llm_reports_cost === true,
    };
    this.streams = new StreamStore(join(stateDir, "streams"), (name, err) => {
      logLine("error", "a stream's manifest cannot be read; it is left out", { stream_id: name, error: String(err) });
    });
    this.liveNetworkInTests = capabilities.live_network_in_tests === true;
    this.supervisorEnv = {
      hostPeer: this.peer,
      command: this.options.command ?? selfCommand(),
      now: this.now,
      hostResponseMs,
      llmReportsCost: this.context.llmReportsCost,
      sandboxExec: sandboxAvailable ? this.sandbox.path : null,
      tempRoot: join(stateDir, "run-tmp"),
      streamDir: (streamId) => this.streams.dir(streamId),
      memoryLimitMb: ceilings.run_memory_mb,
      ceilings,
      memorySampleMs: this.options.test?.memorySampleMs,
      injectClock: this.options.now !== undefined,
      test: this.options.test,
      log: (level, msg, fields) => this.log(level, msg, fields),
      onStarted: (job, startedAt) => {
        this.log("info", "run started", { run_id: job.run_id, stream_id: job.stream_id });
        this.peer.notify("run.started", { run_id: job.run_id, stream_id: job.stream_id, trigger: job.trigger, scheduled_for: job.scheduled_for, started_at: startedAt });
      },
    };
    this.queue = new RunQueue({
      ...this.supervisorEnv,
      currentManifest: (streamId) => this.streams.get(streamId),
      sandboxRefusal: () => (!sandboxAvailable && this.sandboxRequired ? `This host requires the OS sandbox and it is not available: ${this.sandbox.reason}` : null),
      emitFinished: (report) => {
        this.log("info", "run finished", { run_id: report.run_id, stream_id: report.stream_id, status: report.status });
        // Capped pieces make this far smaller already; a report that vanished would leave the host guessing.
        this.peer.notify("run.finished", { report: truncateResult(report, MAX_REPORT_BYTES) });
      },
    });
    if (params.clock === "engine") {
      this.scheduler = new Scheduler({
        now: this.now,
        streams: this.streams,
        enqueue: (manifest, scheduledFor) => this.queue.enqueue(manifest, { trigger: "schedule", scheduled_for: scheduledFor, collapsible: false }),
      });
      if (!this.options.test?.noSchedulerTimer) this.scheduler.start();
    }
    this.initialized = true;
    this.log("info", "engine initialized", { clock: params.clock, sandbox: sandboxAvailable ? "seatbelt" : "none" });
    return {
      protocol_version: params.protocol_version,
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
      pipeline_formats: PIPELINE_FORMATS,
      report_version: REPORT_VERSION,
      sandbox: { available: sandboxAvailable, mechanism: sandboxAvailable ? "seatbelt" : "none" },
      ceilings,
      components: publicComponents(),
      tools: TOOLS,
      host_tools_suggested: HOST_TOOLS_SUGGESTED,
      streams: this.streams.all().map((m) => this.streamRow(m)),
    };
  }

  private listComponents(params: any): unknown {
    const all = publicComponents();
    return {
      components: params?.kind ? all.filter((c) => c.kind === params.kind) : all,
      format: PIPELINE_FORMATS[0],
      ceilings: this.context.ceilings,
      pipeline_schema: pipelineSchema(),
      report_schema: REPORT_SCHEMA,
      condition: CONDITION_DOC,
    };
  }

  private validate(params: any): unknown {
    const result = validatePipeline(params?.pipeline, this.context);
    if (!result.valid) return { valid: false, errors: result.errors, warnings: result.warnings };
    return {
      valid: true,
      errors: [],
      warnings: result.warnings,
      permissions: result.permissions,
      permissions_hash: result.permissions_hash,
      rendered: result.rendered,
    };
  }

  private requireValid(pipeline: unknown) {
    const result = validatePipeline(pipeline, this.context);
    if (!result.valid) {
      throw new RpcError("invalid_pipeline", `The pipeline is not valid: ${result.errors[0]?.message ?? "see errors"}`, { errors: result.errors });
    }
    return result;
  }

  private async testPipeline(params: any, ctx: RequestContext): Promise<unknown> {
    const result = validatePipeline(params?.pipeline, { ...this.context, testing: true });
    if (!result.valid) {
      throw new RpcError("invalid_pipeline", `The pipeline is not valid: ${result.errors[0]?.message ?? "see errors"}`, { errors: result.errors });
    }
    this.requireSandbox();
    const once = async (test: Partial<TestParams>) => {
      if (test.network === "live" && !this.liveNetworkInTests) {
        throw new RpcError("permission_denied", "This host does not allow live network in tests.");
      }
      const running = runPipelineTest(
        { ...test, pipeline: params.pipeline, permissions: result.permissions, permissions_hash: result.permissions_hash },
        this.supervisorEnv,
        ctx.signal,
        (process, active) => {
          if (active) this.activeTests.add(process);
          else this.activeTests.delete(process);
        },
      );
      this.testsFinished.add(running);
      void running.finally(() => this.testsFinished.delete(running)).catch(() => {});
      return running;
    };
    if (params.run_embedded !== true) {
      return once({ input: params.input, llm: params.llm, fixtures: params.fixtures, network: params.network, clock: params.clock, state: params.state });
    }
    const tests: Array<{ name: string; passed: boolean; failures: string[]; status: string }> = [];
    for (const test of (params.pipeline.tests ?? []) as EmbeddedTest[]) {
      const outcome = await once(test);
      const failures = checkExpectations(outcome, test.expect);
      tests.push({ name: test.name, passed: failures.length === 0, failures, status: outcome.status });
    }
    const failed = tests.filter((t) => !t.passed).length;
    return { status: failed === 0 ? "passed" : "failed", passed: tests.length - failed, failed, tests };
  }

  private createStream(params: any): unknown {
    const result = this.requireValid(params?.pipeline);
    const now = this.now().toISOString();
    const description = typeof params.schedule_description === "string" ? params.schedule_description : undefined;
    const manifest: Manifest = {
      stream_id: newStreamId(),
      name: params.pipeline.name,
      status: "pending_approval",
      start_paused: params.start_paused === true,
      pinned: null,
      pending: null,
      ...(description ? { schedule_description: description } : {}),
      pipeline: params.pipeline,
      permissions: result.permissions,
      permissions_hash: result.permissions_hash,
      rendered: withDescription(result.rendered, description),
      rendered_version: 1,
      created_at: now,
      updated_at: now,
    };
    this.streams.save(manifest);
    return {
      stream_id: manifest.stream_id,
      status: manifest.status,
      permissions: manifest.permissions,
      permissions_hash: manifest.permissions_hash,
      rendered: manifest.rendered,
    };
  }

  private manifest(params: any): Manifest {
    const streamId = requireString(params, "stream_id");
    const manifest = this.streams.get(streamId);
    if (!manifest) throw new RpcError("not_found", `There is no stream with the id ${streamId}.`);
    return manifest;
  }

  private save(manifest: Manifest, changes: Partial<Manifest>): Manifest {
    const updated = { ...manifest, ...changes, updated_at: this.now().toISOString() };
    this.streams.save(updated);
    return updated;
  }

  private approveStream(params: any): unknown {
    const manifest = this.manifest(params);
    const waiting = manifest.pending?.permissions_hash ?? manifest.permissions_hash;
    if (params.permissions_hash !== waiting) {
      throw new RpcError("conflict", "These are not the permissions this stream has now; show the current ones and ask again.", {
        reason: "stale_hash",
        current: waiting,
      });
    }
    if (manifest.status !== "pending_approval") return { stream_id: manifest.stream_id, status: manifest.status };
    let updated: Manifest;
    if (manifest.pending) {
      this.streams.savePrevious(manifest.stream_id, previousOf(manifest));
      const { resume_status, ...approved } = manifest.pending;
      updated = this.save(manifest, { ...approved, name: approved.pipeline.name, status: resume_status, pending: null, pinned: pinnedOf(approved) });
    } else {
      updated = this.save(manifest, { status: manifest.start_paused ? "paused" : "active", pinned: pinnedOf(manifest) });
    }
    if (updated.status === "active") this.scheduler?.markActivated(updated);
    return { stream_id: updated.stream_id, status: updated.status };
  }

  private async updateStream(params: any): Promise<unknown> {
    const manifest = this.manifest(params);
    const result = this.requireValid(params?.pipeline);
    const description = manifest.schedule_description;
    const next: PinnedPipeline = {
      pipeline: params.pipeline,
      permissions: result.permissions,
      permissions_hash: result.permissions_hash,
      rendered: withDescription(result.rendered, description),
      rendered_version: 1,
    };
    const answer = (status: string, diff?: { added: string[]; removed: string[] }) => ({
      stream_id: manifest.stream_id,
      status,
      permissions: next.permissions,
      permissions_hash: next.permissions_hash,
      rendered: next.rendered,
      ...(diff ? { diff } : {}),
    });

    // Never approved: nothing is pinned, so this just replaces what is waiting.
    if (!manifest.pinned) {
      this.save(manifest, { ...next, name: params.pipeline.name });
      return answer("pending_approval", sentenceDiff(next.rendered, this.sentences(manifest, manifest)));
    }

    const previous = this.streams.previous(manifest.stream_id);
    const isRollback = previous !== null && canonicalJson(previous.pipeline) === canonicalJson(params.pipeline);
    const status = manifest.pending ? manifest.pending.resume_status : (manifest.status as "active" | "paused");
    if (isRollback || isSubset(next.permissions, manifest.pinned.permissions)) {
      // Applies at once and keeps the state. Rollback restores what the person approved back then.
      this.streams.savePrevious(manifest.stream_id, previousOf(manifest));
      const pinned = isRollback ? previous.pinned : manifest.pinned;
      const updated = this.save(manifest, { ...next, name: params.pipeline.name, status, pending: null, pinned });
      if (updated.status !== manifest.status) {
        this.announceStatus(updated, isRollback ? "rolled_back" : "update_applied");
        // It could not run while waiting, so what passed meanwhile is not made up.
        if (updated.status === "active") this.scheduler?.markActivated(updated);
      }
      return answer(updated.status);
    }

    if (!manifest.pending) this.streams.savePrevious(manifest.stream_id, previousOf(manifest));
    const updated = this.save(manifest, { status: "pending_approval", pending: { ...next, resume_status: status } });
    await this.queue.cancelStream(manifest.stream_id, "pending_approval", false);
    if (manifest.status !== updated.status) this.announceStatus(updated, "permissions_widened");
    return answer("pending_approval", sentenceDiff(next.rendered, this.sentences(manifest, manifest)));
  }

  // Rendered on each read and not taken from the manifest. Whether the sandbox works, whether the host
  // reports cost and what it is called are facts of this engine and this host, not of the pipeline, and
  // a sentence must not say "OS sandbox: on" because it once was. The hash covers none of them.
  private sentences(pinned: PinnedPipeline, manifest: Manifest): string[] {
    return withDescription(renderPermissions(pinned.permissions, this.context), manifest.schedule_description);
  }

  // The host learns of it through its own tool loop only if it looks; a status it must act on is announced.
  private announceStatus(manifest: Manifest, reason: string): void {
    this.peer.notify("stream.changed", { stream_id: manifest.stream_id, status: manifest.status, reason });
  }

  private async pauseStream(params: any): Promise<unknown> {
    const manifest = this.manifest(params);
    if (manifest.status === "pending_approval") {
      throw new RpcError("conflict", "A stream waiting for approval cannot be paused.", { reason: "pending_approval" });
    }
    const updated = manifest.status === "paused" ? manifest : this.save(manifest, { status: "paused" });
    await this.queue.cancelStream(manifest.stream_id, "paused", false);
    return { stream_id: updated.stream_id, status: "paused" };
  }

  private resumeStream(params: any): unknown {
    const manifest = this.manifest(params);
    if (manifest.status === "pending_approval") {
      throw new RpcError("conflict", "A stream waiting for approval cannot be resumed.", { reason: "pending_approval" });
    }
    const updated = manifest.status === "active" ? manifest : this.save(manifest, { status: "active" });
    if (manifest.status !== "active") this.scheduler?.markActivated(updated);
    return { stream_id: updated.stream_id, status: "active", next_run: this.scheduler?.nextRun(updated) ?? null };
  }

  private async deleteStream(params: any): Promise<unknown> {
    const manifest = this.manifest(params);
    this.streams.forget(manifest.stream_id);
    await this.queue.cancelStream(manifest.stream_id, "stream_deleted", true);
    this.streams.removeFiles(manifest.stream_id);
    return { stream_id: manifest.stream_id, status: "deleted" };
  }

  private getStream(params: any): unknown {
    const m = this.manifest(params);
    const previous = this.streams.previous(m.stream_id);
    return {
      stream_id: m.stream_id,
      name: m.name,
      status: m.status,
      pipeline: m.pipeline,
      permissions: m.permissions,
      permissions_hash: m.permissions_hash,
      rendered: this.sentences(m, m),
      ...(previous ? { previous_pipeline: previous.pipeline } : {}),
      ...(m.pending ? { pending: { pipeline: m.pending.pipeline, permissions: m.pending.permissions, permissions_hash: m.pending.permissions_hash, rendered: this.sentences(m.pending, m) } } : {}),
      created_at: m.created_at,
      updated_at: m.updated_at,
      next_run: this.scheduler?.nextRun(m) ?? null,
    };
  }

  private streamRow(m: Manifest) {
    return {
      stream_id: m.stream_id,
      name: m.name,
      status: m.status,
      permissions_hash: m.pending?.permissions_hash ?? m.permissions_hash,
      next_run: this.scheduler?.nextRun(m) ?? null,
      permission_sentences: this.sentences(m.pending ?? m, m),
    };
  }

  private triggerRun(params: any): unknown {
    const manifest = this.manifest(params);
    if (this.queue.stopping) throw new RpcError("conflict", "The engine is shutting down.", { reason: "shutting_down" });
    if (manifest.status === "pending_approval") {
      throw new RpcError("permission_denied", "This stream's permissions have not been approved.");
    }
    if (manifest.status === "paused") throw new RpcError("conflict", "This stream is paused.", { reason: "paused" });
    this.requireSandbox();
    const scheduledFor = typeof params.scheduled_for === "string" ? params.scheduled_for : null;
    return this.queue.enqueue(manifest, { trigger: "host", scheduled_for: scheduledFor, collapsible: true });
  }

  private requireSandbox(): void {
    if (!this.sandbox.available && this.sandboxRequired) {
      throw new RpcError("sandbox_unavailable", "This host requires the OS sandbox and it is not available.", { reason: this.sandbox.reason });
    }
  }

  private async shutdown(params: any): Promise<unknown> {
    await this.stop(readDuration(params?.timeout, DEFAULT_SHUTDOWN_TIMEOUT_MS, "timeout"));
    setTimeout(() => this.options.exit(0), 0);
    return {};
  }

  private stop(timeoutMs: number): Promise<void> {
    this.stopping ??= (async () => {
      this.scheduler?.stop();
      // A test is worth nothing once the host is leaving, so it does not get the drain a real run does.
      for (const test of this.activeTests) {
        test.killWith({ status: "cancelled", error: { kind: "cancelled", message: "The engine shut down during the test.", step_id: null, message_id: null, retry_after: null, reason: "shutdown" } });
      }
      await Promise.allSettled(this.testsFinished);
      await this.queue?.drain(timeoutMs);
      this.releaseLock?.();
      this.releaseLock = null;
    })();
    return this.stopping;
  }
}

function previewSchedule(params: any): unknown {
  const invalid = (message: string) => new RpcError("invalid_params", message, { reason: "invalid_schedule" });
  let cron;
  try {
    cron = parseCron(String(params?.cron));
  } catch (err) {
    throw invalid((err as Error).message);
  }
  if (typeof params.timezone !== "string" || !isValidZone(params.timezone)) throw invalid(`${params.timezone} is not an IANA time zone name.`);
  const after = Date.parse(params.after);
  if (Number.isNaN(after)) throw invalid("after must be an RFC 3339 instant.");
  const count = params.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 100) throw invalid("count must be between 1 and 100.");
  return { occurrences: nextOccurrences(cron, params.timezone, after, count).map((t) => toRfc3339(t, params.timezone)) };
}

function pinnedOf(p: PinnedPipeline): NonNullable<Manifest["pinned"]> {
  return { permissions: p.permissions, permissions_hash: p.permissions_hash };
}

function previousOf(m: Manifest): PreviousManifest {
  return { pipeline: m.pipeline, permissions: m.permissions, permissions_hash: m.permissions_hash, rendered: m.rendered, rendered_version: 1, pinned: m.pinned };
}

function withDescription(rendered: string[], description: string | undefined): string[] {
  return description ? [rendered[0]!, description, ...rendered.slice(1)] : rendered;
}

function requireString(params: any, field: string): string {
  const value = params?.[field];
  if (typeof value !== "string" || value === "") throw new RpcError("invalid_params", `${field} is required.`, { reason: `missing_${field}` });
  return value;
}

function readDuration(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !new RegExp(DURATION_PATTERN).test(value)) {
    throw new RpcError("invalid_params", `${field} must be a duration such as 10s.`, { reason: "invalid_duration" });
  }
  return parseDuration(value);
}

function checkStateDir(stateDir: unknown): string {
  const refuse = (reason: string, message: string) => new RpcError("invalid_state_dir", message, { reason });
  if (typeof stateDir !== "string" || stateDir === "") throw refuse("missing", "state_dir is required.");
  let stat;
  try {
    stat = statSync(stateDir);
  } catch {
    throw refuse("missing", `The state directory ${stateDir} does not exist.`);
  }
  if (!stat.isDirectory()) throw refuse("not_a_directory", `${stateDir} is not a directory.`);
  if (stat.uid !== process.getuid!()) throw refuse("wrong_owner", `${stateDir} is not owned by the current user.`);
  if ((stat.mode & 0o777) !== 0o700) {
    throw refuse("wrong_mode", `${stateDir} must have mode 0700; it has ${(stat.mode & 0o777).toString(8).padStart(4, "0")}.`);
  }
  return realpathSync(stateDir);
}
