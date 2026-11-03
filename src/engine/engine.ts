// The `serve` process: handshake, method table and lifecycle. Business logic lives in the modules it
// calls; this file decides what is allowed when.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { publicComponents } from "../components/definitions.ts";
import { logLine, type LogLevel } from "../log.ts";
import { effectiveCeilings, type Ceilings } from "../pipeline/ceilings.ts";
import { DURATION_PATTERN, parseDuration } from "../pipeline/duration.ts";
import { DEFAULT_DISPLAY_NAME } from "../pipeline/render.ts";
import { canonicalJson } from "../pipeline/canonical.ts";
import { pipelineSchema } from "../pipeline/schema.ts";
import { isSubset, sentenceDiff } from "../pipeline/subset.ts";
import { validatePipeline, type ValidationContext } from "../pipeline/validate.ts";
import { RpcError } from "../protocol/errors.ts";
import { Peer, type RequestContext } from "../protocol/peer.ts";
import { selfCommand } from "../self.ts";
import { newStreamId, StreamStore, type Manifest, type PinnedPipeline, type PreviousManifest } from "../state/streams.ts";
import { ENGINE_NAME, ENGINE_VERSION, PIPELINE_FORMATS, PROTOCOL_VERSIONS, REPORT_VERSION } from "../version.ts";
import { tryLock } from "./lock.ts";
import { RunQueue } from "./run-queue.ts";
import { probeSandbox, type SandboxStatus } from "../supervisor/seatbelt.ts";
import type { SupervisorEnv } from "../supervisor/supervisor.ts";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_HOST_RESPONSE_MS = 120_000;

export interface EngineOptions {
  write(line: string): void;
  exit(code: number): void;
  onLine?(direction: "in" | "out", line: string): void;
  now?(): Date;
  // Argv prefix that re-executes the binary; tests running in-process point it at the compiled one.
  command?: string[];
  // Only tests in this repository set these.
  test?: SupervisorEnv["test"] & { memorySampleMs?: number };
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

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.peer = new Peer({
      write: options.write,
      idPrefix: "e-",
      onLine: options.onLine,
      onRequest: (method, params, ctx) => this.dispatch(method, params, ctx),
    });
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

  private async dispatch(method: string, params: any, _ctx: RequestContext): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    if (!this.initialized) {
      throw new RpcError("not_initialized", `The engine must be initialized before ${method}.`);
    }
    switch (method) {
      case "components.list":
        return this.listComponents(params);
      case "pipeline.validate":
        return this.validate(params);
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
    mkdirSync(join(stateDir, "streams"), { recursive: true, mode: 0o700 });
    this.sandbox = probeSandbox();
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
    this.streams = new StreamStore(join(stateDir, "streams"));
    this.queue = new RunQueue({
      hostPeer: this.peer,
      command: this.options.command ?? selfCommand(),
      now: this.now,
      hostResponseMs,
      llmReportsCost: this.context.llmReportsCost,
      sandboxExec: sandboxAvailable ? this.sandbox.path : null,
      tempRoot: join(stateDir, "run-tmp"),
      streamDir: (streamId) => this.streams.dir(streamId),
      memoryLimitMb: ceilings.run_memory_mb,
      memorySampleMs: this.options.test?.memorySampleMs,
      injectClock: this.options.now !== undefined,
      test: this.options.test,
      onStarted: (job, startedAt) => {
        this.peer.notify("run.started", { run_id: job.run_id, stream_id: job.stream_id, trigger: job.trigger, scheduled_for: job.scheduled_for, started_at: startedAt });
      },
      emitFinished: (report) => this.peer.notify("run.finished", { report }),
    });
    this.initialized = true;
    return {
      protocol_version: params.protocol_version,
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
      pipeline_formats: PIPELINE_FORMATS,
      report_version: REPORT_VERSION,
      sandbox: { available: sandboxAvailable, mechanism: sandboxAvailable ? "seatbelt" : "none" },
      ceilings,
      components: publicComponents(),
      tools: [],
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
      return answer("pending_approval", sentenceDiff(next.rendered, manifest.rendered));
    }

    const previous = this.streams.previous(manifest.stream_id);
    const isRollback = previous !== null && canonicalJson(previous.pipeline) === canonicalJson(params.pipeline);
    const status = manifest.pending ? manifest.pending.resume_status : (manifest.status as "active" | "paused");
    if (isRollback || isSubset(next.permissions, manifest.pinned.permissions)) {
      // Applies at once and keeps the state. Rollback restores what the person approved back then.
      this.streams.savePrevious(manifest.stream_id, previousOf(manifest));
      const pinned = isRollback ? previous.pinned : manifest.pinned;
      const updated = this.save(manifest, { ...next, name: params.pipeline.name, status, pending: null, pinned });
      if (updated.status !== manifest.status) this.announceStatus(updated, isRollback ? "rolled_back" : "update_applied");
      return answer(updated.status);
    }

    if (!manifest.pending) this.streams.savePrevious(manifest.stream_id, previousOf(manifest));
    const updated = this.save(manifest, { status: "pending_approval", pending: { ...next, resume_status: status } });
    await this.queue.cancelStream(manifest.stream_id, "pending_approval", false);
    if (manifest.status !== updated.status) this.announceStatus(updated, "permissions_widened");
    return answer("pending_approval", sentenceDiff(next.rendered, manifest.rendered));
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
    return { stream_id: updated.stream_id, status: "active", next_run: null };
  }

  private async deleteStream(params: any): Promise<unknown> {
    const manifest = this.manifest(params);
    await this.queue.cancelStream(manifest.stream_id, "stream_deleted", true);
    this.streams.remove(manifest.stream_id);
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
      rendered: m.rendered,
      ...(previous ? { previous_pipeline: previous.pipeline } : {}),
      ...(m.pending ? { pending: { pipeline: m.pending.pipeline, permissions: m.pending.permissions, permissions_hash: m.pending.permissions_hash, rendered: m.pending.rendered } } : {}),
      created_at: m.created_at,
      updated_at: m.updated_at,
      next_run: null,
    };
  }

  private streamRow(m: Manifest) {
    return {
      stream_id: m.stream_id,
      name: m.name,
      status: m.status,
      permissions_hash: m.pending?.permissions_hash ?? m.permissions_hash,
      next_run: null,
      permission_sentences: m.pending?.rendered ?? m.rendered,
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
      await this.queue?.drain(timeoutMs);
      this.releaseLock?.();
      this.releaseLock = null;
    })();
    return this.stopping;
  }
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
