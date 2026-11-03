// Spawns, watches and kills one run process, forwards its host requests, and assembles the report.
// The run process is not trusted with the numbers: calls, cost and results are counted here.

import { LineSplitter, MAX_PRIVATE_LINE_BYTES } from "../protocol/lines.ts";
import { RpcError, toRpcError } from "../protocol/errors.ts";
import { Peer } from "../protocol/peer.ts";
import type { LogLevel } from "../log.ts";
import { ENGINE_VERSION, PIPELINE_FORMAT, REPORT_VERSION } from "../version.ts";
import { parseDuration } from "../pipeline/duration.ts";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Ceilings } from "../pipeline/ceilings.ts";
import type { Permissions } from "../pipeline/permissions.ts";
import { startProxy, type ProxyOptions, type RunProxy } from "./proxy.ts";
import { generateProfile, programPaths } from "./seatbelt.ts";
import type { RunInit, RunOutcome } from "../executor/messages.ts";
import { allSteps, stepById } from "../pipeline/tree.ts";
import type { ReportError, ReportLog, ReportStep, ReportWarning, RunReport, RunTrigger } from "../report.ts";

export const CANCEL_GRACE_MS = 5000;
// What a run can make the engine hold, or put in a report. The run process is not trusted to be modest.
const MAX_WARNINGS = 200;
const MAX_TEXT_CHARS = 1000;
const MAX_HOSTS = 200;
const MAX_LOGS = 100;
// RLIMIT_CPU, generous enough that a healthy run on many threads never meets it: the wall-clock timeout
// is the real limit, this is for a process that nobody is left to kill.
const CPU_LIMIT_FACTOR = 4;
const CPU_LIMIT_MIN_S = 60;
const EXIT_WAIT_MS = 2000;
const ATTEMPTS = 2;

export interface RunJob {
  run_id: string;
  stream_id: string | null;
  stream_name: string;
  pipeline: any;
  permissions_hash: string;
  // The pinned object: the only source of the proxy allowlist.
  permissions: Permissions;
  trigger: RunTrigger;
  scheduled_for: string | null;
  queued_at: string;
  clock: string | null;
  input_override: RunInit["input_override"];
  // Set in `pipeline.test`: pages come from this table and no socket opens. Null with live network.
  fixtures?: RunInit["fixtures"];
  // Set in `pipeline.test`: nothing is read from disk or written back.
  initial_state?: RunInit["initial_state"];
}

const DEFAULT_MEMORY_SAMPLE_MS = 250;

export interface SupervisorEnv {
  hostPeer: Peer;
  // Argv prefix that re-executes this binary.
  command: string[];
  now(): Date;
  // How long to wait for the host before treating a response as lost.
  hostResponseMs: number;
  llmReportsCost: boolean;
  // The path of `sandbox-exec`, or null to run without an OS sandbox.
  sandboxExec: string | null;
  // Where runs get their private temp directories: <state_dir>/run-tmp.
  tempRoot: string;
  // The stream's directory, for the state files a run may touch. Null in tests, which keep no state.
  streamDir(streamId: string): string;
  memoryLimitMb: number;
  // A host can lower these after a stream was approved; a run keeps to the lower of the two.
  ceilings: Ceilings;
  // How often RSS is sampled. A fast spike can pass the limit briefly before the kill (threat model T9).
  memorySampleMs?: number;
  // True when the engine runs on an injected clock, which the run process must share.
  injectClock: boolean;
  // Lets tests shorten what the format's minimums would make slow, and exercise the watchdog.
  test?: { runTimeoutMs?: number; hook?: RunInit["test_hook"]; dial?: ProxyOptions["dial"] };
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  onStarted(job: RunJob, startedAt: string): void;
  // Replaces the requests the fake world answers in `pipeline.test`.
  hostHandlers?: {
    llm(params: any): Promise<any>;
    result(params: any): Promise<any>;
  };
}

type Terminal = { status: RunReport["status"]; error: ReportError };

export class RunProcess {
  private process!: Bun.PipedSubprocess;
  private peer!: Peer;
  private readonly steps: ReportStep[] = [];
  private readonly warnings: ReportWarning[] = [];
  private readonly logs: ReportLog[] = [];
  private readonly llmRequests: RunReport["llm"]["requests"] = [];
  private readonly results: RunReport["results"] = [];
  private readonly outstanding = new Set<string>();
  private llmCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost: number | null = null;
  private currentStep: string | null = null;
  private startedAt = "";
  private terminal: Terminal | null = null;
  private cancelReason: string | null = null;
  private killTimer: Timer | null = null;
  private timeoutTimer: Timer | null = null;
  private tempDir = "";
  private sandboxFailure: string | null = null;
  private exited = false;
  private proxy: RunProxy | null = null;
  private proxyToken = "";
  private networkRequests = 0;
  private networkBytes = 0;
  private readonly networkHosts = new Set<string>();
  private readonly networkDenied = new Set<string>();
  private spawnFailure: string | null = null;
  private warningsOmitted = 0;
  private logsTruncated = false;
  // The run answered or died; what remains is waiting for the process to be gone.
  private finishing = false;

  constructor(
    readonly job: RunJob,
    private readonly env: SupervisorEnv,
  ) {}

  async run(): Promise<RunReport> {
    this.startedAt = this.env.now().toISOString();
    try {
      this.spawn();
    } catch (err) {
      this.spawnFailure = (err as Error).message;
      this.cleanUp();
      return this.report(null, null);
    }
    this.env.onStarted(this.job, this.startedAt);
    void this.watchMemory();
    const timeout = this.env.test?.runTimeoutMs ?? this.timeoutMs();
    this.timeoutTimer = setTimeout(() => {
      this.killWith({ status: "timed_out", error: this.errorOf("timed_out", `The run passed its limit of ${this.job.pipeline.limits.run_timeout}.`) });
    }, timeout);
    let outcome: RunOutcome | null = null;
    let failure: RpcError | null = null;
    try {
      outcome = await this.peer.request<RunOutcome>("run", this.init()).promise;
    } catch (err) {
      failure = toRpcError(err);
    }
    this.finishing = true;
    clearTimeout(this.timeoutTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    await this.waitForExit();
    this.cleanUp();
    return this.report(outcome, failure);
  }

  private timeoutMs(): number {
    return Math.min(parseDuration(this.job.pipeline.limits.run_timeout), parseDuration(this.env.ceilings.run_timeout));
  }

  private cleanUp(): void {
    this.proxy?.stop();
    if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
  }

  // A cooperative cancel; the process has CANCEL_GRACE_MS to finish its report.
  cancel(reason: string): void {
    if (this.cancelReason !== null || this.terminal || this.finishing) return;
    this.cancelReason = reason;
    this.cancelOutstanding();
    this.peer.notify("cancel", { reason });
    this.killTimer = setTimeout(() => {
      this.killWith({ status: "cancelled", error: { ...this.errorOf("cancelled", "The run did not stop in time and was killed."), reason: "killed_after_timeout" } });
    }, CANCEL_GRACE_MS);
  }

  killWith(terminal: Terminal): void {
    if (this.terminal || this.finishing) return;
    this.terminal = terminal;
    this.cancelOutstanding();
    this.killGroup();
  }

  private init(): RunInit {
    const { run_id, stream_id, pipeline, trigger, scheduled_for, clock, input_override } = this.job;
    const proxy = this.proxy ? { port: this.proxy.port, token: this.proxyToken } : null;
    const state_path = stream_id ? join(this.env.streamDir(stream_id), "state.json") : null;
    return { run_id, stream_id, pipeline, trigger, scheduled_for, clock, input_override, proxy, cpu_limit_s: Math.max(CPU_LIMIT_MIN_S, Math.ceil((this.timeoutMs() / 1000) * CPU_LIMIT_FACTOR)), state_path, initial_state: this.job.initial_state ?? null, fixtures: this.job.fixtures ?? null, ...(this.env.test?.hook ? { test_hook: this.env.test.hook } : {}) };
  }

  private spawn(): void {
    this.tempDir = join(this.env.tempRoot, this.job.run_id);
    mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    this.tempDir = realpathSync(this.tempDir);
    if (this.job.permissions.network.length > 0 && !this.job.fixtures) {
      this.proxyToken = randomBytes(24).toString("hex");
      this.proxy = startProxy({ allowedHosts: this.job.permissions.network.map((n) => n.host), token: this.proxyToken, dial: this.env.test?.dial });
    }
    const command = [realpathSync(this.env.command[0]!), ...this.env.command.slice(1), "--run"];
    this.process = Bun.spawn(this.env.sandboxExec ? [this.env.sandboxExec, "-p", this.profile(), ...command] : command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      cwd: this.tempDir,
      env: { TMPDIR: this.tempDir, HOME: this.tempDir },
    }) as Bun.PipedSubprocess;
    this.peer = new Peer({
      idPrefix: "s-",
      // Outgoing, carrying the run's whole input. What comes back keeps to the public limit.
      maxLineBytes: MAX_PRIVATE_LINE_BYTES,
      write: (line) => {
        void this.process.stdin.write(line);
        void this.process.stdin.flush();
      },
      onRequest: (method, params) => this.onChildRequest(method, params),
      onNotification: (method, params) => this.onChildNotification(method, params),
    });
    void this.pump();
    void this.process.exited.then((code) => {
      this.exited = true;
      // Fails the `run` request when the process died without answering.
      this.peer.close(new RpcError("internal", `The run process exited with code ${code} before finishing.`, { reason: "process_exited" }));
    });
  }

  private profile(): string {
    const streamId = this.job.stream_id;
    const dir = streamId ? this.env.streamDir(streamId) : null;
    return generateProfile({
      programPaths: programPaths(this.env.command),
      tempDir: this.tempDir,
      stateFiles: dir ? [join(dir, "state.json"), join(dir, "state.json.tmp")] : [],
      proxyPort: this.proxy?.port ?? null,
    });
  }

  private async watchMemory(): Promise<void> {
    const limitKb = this.env.memoryLimitMb * 1024;
    const every = this.env.memorySampleMs ?? DEFAULT_MEMORY_SAMPLE_MS;
    while (!this.exited && !this.terminal) {
      await Bun.sleep(every);
      if (this.exited || this.terminal) return;
      const sample = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(this.process.pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const rss = Number((await new Response(sample.stdout).text()).trim());
      if (rss > limitKb) {
        this.killWith({ status: "failed", error: this.errorOf("memory_limit", `The run used ${Math.round(rss / 1024)} MB, past the ceiling of ${this.env.memoryLimitMb} MB.`) });
        return;
      }
    }
  }

  private async pump(): Promise<void> {
    const out = new LineSplitter({ onLine: (line) => this.peer.receive(line), onOversize: () => this.killGroup() });
    const err = new LineSplitter(
      {
        onLine: (line) => {
          if (line.startsWith("sandbox-exec:")) this.sandboxFailure = line;
          this.env.log("warn", "run process stderr", { run_id: this.job.run_id, line: line.slice(0, 2000) });
        },
        onOversize: () => {},
      },
      64 * 1024,
    );
    const drain = async (stream: ReadableStream<Uint8Array>, splitter: LineSplitter) => {
      try {
        for await (const chunk of stream) splitter.push(chunk);
      } catch {
        // The pipe went away with the process; `exited` reports that.
      }
    };
    await Promise.all([drain(this.process.stdout as ReadableStream<Uint8Array>, out), drain(this.process.stderr as ReadableStream<Uint8Array>, err)]);
  }

  private onChildNotification(method: string, params: any): void {
    if (method === "step.started") {
      this.currentStep = bounded(params.step_id);
    } else if (method === "step.finished") {
      if (this.steps.length < allSteps(this.job.pipeline).length + 2) {
        const { parent, invocations, ...counts } = params;
        this.steps.push({ ...counts, step_id: bounded(params.step_id), ...(parent !== undefined ? { parent: bounded(parent), invocations: Number(invocations) || 0 } : {}) } as ReportStep);
      }
    } else if (method === "warning") {
      if (this.warnings.length >= MAX_WARNINGS) this.warningsOmitted++;
      else this.warnings.push({ step_id: bounded(params.step_id), message_id: params.message_id === null ? null : bounded(params.message_id), code: bounded(params.code), message: bounded(params.message) });
    } else if (method === "log") {
      if (this.logs.length < MAX_LOGS) this.logs.push({ step_id: bounded(params.step_id), message_id: bounded(params.message_id), text: bounded(params.text) });
      else this.logsTruncated = true;
    } else if (method === "network") {
      this.networkRequests++;
      this.networkBytes += Number(params.bytes) || 0;
      if (this.networkHosts.size < MAX_HOSTS) this.networkHosts.add(bounded(params.host));
    } else if (method === "denied") {
      if (this.networkDenied.size < MAX_HOSTS) this.networkDenied.add(bounded(params.host));
    }
  }

  private onChildRequest(method: string, params: any): Promise<unknown> {
    if (method === "host.llm") return this.forwardLlm(params);
    if (method === "host.result") return this.forwardResult(params);
    throw new RpcError("method_not_found", `There is no method named ${method}.`);
  }

  private async forwardLlm(params: any): Promise<unknown> {
    // What may be asked comes from the pinned permissions and the pipeline. From the run process only
    // the text of the prompt is taken, because a compromised one must not get more than a healthy one.
    const permitted = this.job.permissions.llm;
    const step = stepById(this.job.pipeline, params.step_id)?.config;
    const prompt = params.messages?.[0]?.content;
    if (!permitted || step?.type !== "host_llm" || typeof prompt !== "string" || typeof params.message_id !== "string") {
      throw new RpcError("permission_denied", "This stream's permissions do not include that model call.");
    }
    const limit = Math.min(permitted.max_calls_per_run, this.env.ceilings.llm_calls_per_run);
    if (this.llmCalls >= limit) {
      throw new RpcError("budget_exceeded", `The pipeline allows at most ${limit} model calls per run.`, { limit: "llm_calls_per_run", value: limit });
    }
    this.llmCalls++;
    const started = Date.now();
    const key = `${this.job.run_id}/${params.step_id}/${params.message_id}`;
    const request = (attempt: number) => ({
      run_id: this.job.run_id,
      stream_id: this.job.stream_id,
      step_id: params.step_id,
      message_id: params.message_id,
      attempt,
      idempotency_key: key,
      ...(step.system !== undefined ? { system: step.system } : {}),
      messages: [{ role: "user", content: prompt }],
      ...(step.max_output_tokens !== undefined ? { max_output_tokens: step.max_output_tokens } : {}),
    });
    const { reply, attempt } = await this.askHost("host.llm", request, this.env.hostHandlers?.llm);
    if (typeof reply?.text !== "string" || typeof reply?.usage?.input_tokens !== "number" || typeof reply?.usage?.output_tokens !== "number") {
      throw new RpcError("host_error", "The host answered host.llm without text and usage.", { reason: "invalid_response" });
    }
    this.inputTokens += reply.usage.input_tokens;
    this.outputTokens += reply.usage.output_tokens;
    if (typeof reply.usage.cost_usd === "number") this.cost = (this.cost ?? 0) + reply.usage.cost_usd;
    this.llmRequests.push({ idempotency_key: key, attempt, provider: reply.provider ?? null, model: reply.model ?? null, duration_ms: Date.now() - started });
    const cap = this.job.pipeline.limits.llm_cost_per_run_usd as number | undefined;
    if (cap !== undefined && this.env.llmReportsCost && this.cost !== null && this.cost > cap) {
      throw new RpcError("budget_exceeded", `The run cost $${this.cost.toFixed(4)}, past its limit of $${cap}.`, { limit: "llm_cost_per_run_usd", value: this.cost });
    }
    return reply;
  }

  private async forwardResult(params: any): Promise<unknown> {
    const output = this.job.pipeline.output;
    const body = params.result?.body;
    if (this.job.permissions.results.kind !== "host" || output.type !== "host_result" || typeof body !== "string" || typeof params.message_id !== "string") {
      throw new RpcError("permission_denied", "This stream's permissions do not include writing that result.");
    }
    const key = `${this.job.run_id}/${params.message_id}`;
    const result = { title: output.title as string, body, format: (output.format ?? "markdown") as string };
    const request = () => ({ run_id: this.job.run_id, stream_id: this.job.stream_id, message_id: params.message_id, idempotency_key: key, result });
    const { reply } = await this.askHost("host.result", request, this.env.hostHandlers?.result);
    if (reply?.accepted !== true) throw new RpcError("host_error", "The host did not accept the result.", { reason: "not_accepted" });
    if (!this.results.some((r) => r.idempotency_key === key)) {
      this.results.push({ idempotency_key: key, ref: typeof reply.ref === "string" ? reply.ref : null, title: result.title });
    }
    return reply;
  }

  // Sends a request to the host. A response that does not come in time counts as lost, and the same
  // key goes out again once; the host answers a repeated key from its own record, so nothing is paid twice.
  private async askHost(method: string, request: (attempt: number) => object, fake?: (params: any) => Promise<any>): Promise<{ reply: any; attempt: number }> {
    if (this.cancelReason !== null || this.terminal) throw new RpcError("cancelled", "The run was cancelled.", { reason: this.cancelReason ?? "killed" });
    if (fake) return { reply: await fake(request(1)), attempt: 1 };
    for (let attempt = 1; ; attempt++) {
      const pending = this.env.hostPeer.request(method, request(attempt));
      this.outstanding.add(pending.id);
      const timer = setTimeout(() => {
        this.env.hostPeer.abandon(pending.id, new RpcError("host_error", `The host did not answer ${method} in time.`, { reason: "no_response" }));
      }, this.env.hostResponseMs);
      try {
        return { reply: await pending.promise, attempt };
      } catch (err) {
        const lost = err instanceof RpcError && err.extras.reason === "no_response";
        if (!lost || attempt >= ATTEMPTS || this.cancelReason !== null) throw err;
      } finally {
        clearTimeout(timer);
        this.outstanding.delete(pending.id);
      }
    }
  }

  private cancelOutstanding(): void {
    for (const id of [...this.outstanding]) {
      this.env.hostPeer.notify("$/cancel", { id });
      this.env.hostPeer.abandon(id, new RpcError("cancelled", "The run was cancelled.", { reason: this.cancelReason ?? "killed" }));
    }
  }

  private killGroup(): void {
    // Once it has exited the pid may belong to someone else.
    if (this.exited || !this.process) return;
    try {
      process.kill(-this.process.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  private async waitForExit(): Promise<void> {
    const exited = await Promise.race([this.process.exited.then(() => true), Bun.sleep(EXIT_WAIT_MS).then(() => false)]);
    if (!exited) {
      this.killGroup();
      await this.process.exited;
    }
  }

  private errorOf(kind: string, message: string): ReportError {
    return { kind, message, step_id: this.currentStep, message_id: null, retry_after: null };
  }

  private report(outcome: RunOutcome | null, failure: RpcError | null): RunReport {
    let status: RunReport["status"];
    let error: ReportError | null;
    if (this.terminal) {
      ({ status, error } = this.terminal);
    } else if (outcome) {
      status = outcome.status;
      error = outcome.error ? { retry_after: null, ...outcome.error, message: bounded(outcome.error.message) } : null;
    } else {
      status = "failed";
      const exited = failure?.extras.reason === "process_exited";
      error = this.spawnFailure
        ? this.errorOf("spawn_failed", `The run process could not start: ${this.spawnFailure}`)
        : this.sandboxFailure
        ? this.errorOf("sandbox_unavailable", `The sandbox could not be set up: ${this.sandboxFailure}`)
        : this.errorOf(exited ? "process_exited" : (failure?.kind ?? "internal"), failure?.message ?? "The run process stopped without a report.");
    }
    if (this.cancelReason !== null && status !== "succeeded" && error) {
      status = "cancelled";
      error = { ...error, kind: "cancelled", reason: error.reason ?? this.cancelReason };
    }
    return {
      report_version: REPORT_VERSION as 1,
      run_id: this.job.run_id,
      stream_id: this.job.stream_id,
      stream_name: this.job.stream_name,
      pipeline_format: PIPELINE_FORMAT,
      permissions_hash: this.job.permissions_hash,
      trigger: this.job.trigger,
      scheduled_for: this.job.scheduled_for,
      queued_at: this.job.queued_at,
      started_at: this.startedAt,
      finished_at: this.env.now().toISOString(),
      status,
      error,
      warnings: [
        ...this.warnings,
        ...(this.warningsOmitted > 0 ? [{ step_id: "report", message_id: null, code: "warnings_omitted", message: `${this.warningsOmitted} more warnings were left out.` }] : []),
        ...(this.logsTruncated ? [{ step_id: "report", message_id: null, code: "logs_truncated", message: `Only the first ${MAX_LOGS} log lines were kept.` }] : []),
      ],
      steps: this.steps,
      ...(this.logs.length > 0 ? { logs: this.logs } : {}),
      llm: { calls: this.llmCalls, input_tokens: this.inputTokens, output_tokens: this.outputTokens, cost_usd: this.cost, requests: this.llmRequests },
      network: {
        requests: this.networkRequests,
        bytes: this.networkBytes,
        hosts: [...new Set([...this.networkHosts, ...(this.proxy?.hosts ?? [])])].sort(),
        denied: [...new Set([...this.networkDenied, ...(this.proxy?.denied ?? [])])].sort(),
      },
      results: this.results,
      state: outcome?.state ?? { committed: false, dedupe_keys: 0 },
      sandbox: this.env.sandboxExec ? "seatbelt" : "none",
      engine_version: ENGINE_VERSION,
      ...(status === "cancelled" ? { cancelled_at_step: this.currentStep } : {}),
      // Every source read fine and there was nothing to deliver: the host can say "nothing new today".
      ...(status === "succeeded" && this.results.length === 0 && this.warnings.length === 0 && this.job.pipeline.output.type === "host_result" ? { nothing_new: true } : {}),
    };
  }
}

function bounded(value: unknown): string {
  return String(value).slice(0, MAX_TEXT_CHARS);
}

export function unstartedReport(job: RunJob, now: Date, status: "cancelled" | "skipped" | "failed", error: ReportError, extras: Partial<RunReport> & Record<string, unknown> = {}): RunReport {
  return {
    report_version: REPORT_VERSION as 1,
    run_id: job.run_id,
    stream_id: job.stream_id,
    stream_name: job.stream_name,
    pipeline_format: PIPELINE_FORMAT,
    permissions_hash: job.permissions_hash,
    trigger: job.trigger,
    scheduled_for: job.scheduled_for,
    queued_at: job.queued_at,
    started_at: null,
    finished_at: now.toISOString(),
    status,
    error,
    warnings: [],
    steps: [],
    llm: { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: null, requests: [] },
    network: { requests: 0, bytes: 0, hosts: [], denied: [] },
    results: [],
    state: { committed: false, dedupe_keys: 0 },
    sandbox: "none",
    engine_version: ENGINE_VERSION,
    ...extras,
  };
}
