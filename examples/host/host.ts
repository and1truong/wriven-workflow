// An example host: what Wriven (or any app) has to do to run wriven-workflow. It spawns the
// engine, answers `host.llm` with its own provider and key, stores results and run reports (the
// engine keeps no history), and gates every stream behind an approval the person gives.
// Guide: docs/host-integration.md. Contract: .agents/specs/host-protocol.md.

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Completion, Provider } from "./provider.ts";
import { EngineConnection, HostError } from "./rpc.ts";

export interface HostOptions {
  // argv prefix that starts the engine; `serve` is appended.
  engine: string[];
  // Where this host keeps its data: the engine's state directory, results, run reports.
  dataDir: string;
  provider: Provider;
  // `required` refuses to run anything without the OS sandbox.
  sandbox?: "required" | "optional";
  // Appears in permission sentences: "Writes results to: <display name>."
  displayName?: string;
  log?: (line: string) => void;
}

export interface ApprovalCard {
  stream_id: string;
  name: string;
  // The English sentences the engine derived from the pipeline. Code wrote them, not a model.
  rendered: string[];
  permissions_hash: string;
  // Present when a running stream asks for more than was approved.
  diff?: { added: string[]; removed: string[] };
}

export interface StoredResult {
  ref: string;
  run_id: string;
  stream_id: string;
  title: string;
  body: string;
  format: string;
  path: string;
}

export class ExampleHost {
  init: any;
  readonly results: StoredResult[] = [];
  readonly reports = new Map<string, any>();
  // Streams waiting for the person, from stream.changed; the CLI turns them into cards.
  readonly needsApproval = new Set<string>();

  private engine!: EngineConnection;
  private readonly resultsDir: string;
  private readonly reportsDir: string;
  private readonly stateDir: string;
  // Per run: the provider call for each idempotency key, finished or in flight. A repeated key
  // is answered from here, so a lost response never pays twice and a slow call is joined.
  private readonly llmByRun = new Map<string, Map<string, Promise<Completion>>>();
  private readonly abortByRequest = new Map<string | number, AbortController>();
  // Per stream: llm_calls_per_run of the pipeline the person approved. Counted here too, so a
  // bug on either side cannot overspend.
  private readonly approvedLimit = new Map<string, number>();
  private readonly resultByKey = new Map<string, { accepted: true; ref: string }>();
  private readonly startedByRun = new Map<string, any>();
  private readonly finishWaiters = new Map<string, (report: any) => void>();

  private constructor(private readonly options: HostOptions) {
    this.stateDir = join(options.dataDir, "engine");
    this.resultsDir = join(options.dataDir, "results");
    this.reportsDir = join(options.dataDir, "reports");
  }

  static async start(options: HostOptions): Promise<ExampleHost> {
    const host = new ExampleHost(options);
    await host.connect();
    return host;
  }

  private async connect(): Promise<void> {
    for (const dir of [this.stateDir, this.resultsDir, this.reportsDir]) mkdirSync(dir, { recursive: true });
    // The engine refuses a state directory anyone else can read.
    chmodSync(this.stateDir, 0o700);
    this.engine = new EngineConnection(this.options.engine, {
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onNotification: (method, params) => this.onNotification(method, params),
      onStderr: (line) => this.log(`engine: ${line}`),
    });
    this.init = await this.engine.request("initialize", {
      protocol_version: 1,
      host: { name: "wriven-workflow-example-host", version: "0.0.0", display_name: this.options.displayName ?? "Example Host" },
      // This host owns the clock: the engine never starts a run on its own.
      clock: "host",
      state_dir: realpathSync(this.stateDir),
      sandbox: this.options.sandbox ?? "required",
      capabilities: { llm: true, llm_reports_cost: true, results: true, live_network_in_tests: false },
      // Above the provider timeout, so the engine repeats a key only when a response was lost.
      timeouts: { host_response: "300s" },
    });
    if (!this.init.sandbox?.available && (this.options.sandbox ?? "required") === "required") {
      throw new Error("The OS sandbox is not available, so this host will not run automations. Run `wriven-workflow doctor`.");
    }
    // Rebuild what this host must know after a restart: the approved limits of active streams.
    for (const stream of this.init.streams ?? []) {
      if (stream.status === "pending_approval") this.needsApproval.add(stream.stream_id);
      else await this.loadApprovedLimit(stream.stream_id);
    }
  }

  // Any host → engine method. The agent's tools come through here too.
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    return this.engine.request<T>(method, params);
  }

  // What the person sees before anything runs.
  async approvalCard(streamId: string): Promise<ApprovalCard | null> {
    const stream = await this.call("stream.get", { stream_id: streamId });
    // A widening update waits in `pending`, next to the approved sentences it would replace; a
    // new stream waits at the top level.
    const waiting = stream.pending ?? (stream.status === "pending_approval" ? stream : null);
    if (!waiting) return null;
    const card: ApprovalCard = { stream_id: streamId, name: stream.name, rendered: waiting.rendered, permissions_hash: waiting.permissions_hash };
    if (stream.pending) {
      const before = new Set<string>(stream.rendered);
      const after = new Set<string>(waiting.rendered);
      card.diff = { added: waiting.rendered.filter((s: string) => !before.has(s)), removed: stream.rendered.filter((s: string) => !after.has(s)) };
    }
    return card;
  }

  // The person said yes to exactly this card. A stale hash gets `conflict` from the engine, so a
  // card that showed old sentences cannot approve something it did not show.
  async approve(card: ApprovalCard): Promise<void> {
    await this.call("stream.approve", { stream_id: card.stream_id, permissions_hash: card.permissions_hash });
    this.needsApproval.delete(card.stream_id);
    await this.loadApprovedLimit(card.stream_id);
  }

  async decline(card: ApprovalCard): Promise<void> {
    await this.call("stream.delete", { stream_id: card.stream_id });
    this.needsApproval.delete(card.stream_id);
  }

  // "Run now": trigger and wait for the report. A host with a scheduler would pass `scheduled_for`.
  async runNow(streamId: string): Promise<any> {
    const { run_id } = await this.call("run.trigger", { stream_id: streamId, reason: "run_now" });
    const done = this.reports.get(run_id);
    if (done) return done;
    return new Promise((resolve) => this.finishWaiters.set(run_id, resolve));
  }

  async stop(): Promise<number> {
    return this.engine.shutdown();
  }

  private async loadApprovedLimit(streamId: string): Promise<number> {
    const stream = await this.call("stream.get", { stream_id: streamId });
    const limit = stream.pipeline?.limits?.llm_calls_per_run ?? 0;
    this.approvedLimit.set(streamId, limit);
    return limit;
  }

  private async onRequest(method: string, params: any, id: string | number): Promise<unknown> {
    switch (method) {
      case "host.llm":
        return this.answerLlm(params, id);
      case "host.result":
        return this.answerResult(params);
      default:
        throw new HostError("method_not_found", `This host does not serve ${method}.`);
    }
  }

  private async answerLlm(params: any, id: string | number): Promise<Completion> {
    const calls = this.llmByRun.get(params.run_id) ?? new Map<string, Promise<Completion>>();
    this.llmByRun.set(params.run_id, calls);
    const known = calls.get(params.idempotency_key);
    if (known) return known;

    const limit = this.approvedLimit.get(params.stream_id) ?? (await this.loadApprovedLimit(params.stream_id));
    const value = calls.size + 1;
    if (value > limit) {
      throw new HostError("budget_exceeded", `This run already made the ${limit} model calls its permissions allow.`, { limit, value });
    }
    const controller = new AbortController();
    this.abortByRequest.set(id, controller);
    const call = this.options.provider.complete({
      system: params.system,
      prompt: (params.messages ?? []).map((m: any) => m.content).join("\n\n"),
      maxOutputTokens: params.max_output_tokens,
      signal: controller.signal,
    });
    calls.set(params.idempotency_key, call);
    try {
      return await call;
    } finally {
      this.abortByRequest.delete(id);
    }
  }

  private async answerResult(params: any): Promise<{ accepted: true; ref: string }> {
    const known = this.resultByKey.get(params.idempotency_key);
    if (known) return known;
    const ref = `${params.run_id}-${this.results.length + 1}`;
    const started = this.startedByRun.get(params.run_id);
    const { title, body, format } = params.result;
    const path = join(this.resultsDir, `${ref}.md`);
    // Stamped with the run's times, not the time of this call: a late delivery is not a late result.
    const header = [`# ${title}`, "", `Stream ${params.stream_id}, run ${params.run_id}.`, `Scheduled for ${started?.scheduled_for ?? "(run now)"}, started ${started?.started_at ?? "?"}.`, ""];
    writeFileSync(path, `${header.join("\n")}\n${body}\n`);
    this.results.push({ ref, run_id: params.run_id, stream_id: params.stream_id, title, body, format, path });
    const answer = { accepted: true as const, ref };
    this.resultByKey.set(params.idempotency_key, answer);
    return answer;
  }

  private onNotification(method: string, params: any): void {
    switch (method) {
      case "run.started":
        this.startedByRun.set(params.run_id, params);
        return;
      case "run.finished": {
        const report = params.report;
        this.reports.set(report.run_id, report);
        writeFileSync(join(this.reportsDir, `${report.run_id}.json`), `${JSON.stringify(report, null, 2)}\n`);
        // Idempotency keys only live for the run.
        this.llmByRun.delete(report.run_id);
        this.startedByRun.delete(report.run_id);
        this.finishWaiters.get(report.run_id)?.(report);
        this.finishWaiters.delete(report.run_id);
        return;
      }
      case "stream.changed":
        // Usually the model widened a stream through workflow_update_stream: it cannot run
        // until the person approves the new card.
        if (params.status === "pending_approval") this.needsApproval.add(params.stream_id);
        else if (params.reason === "update_applied" || params.reason === "rolled_back") void this.loadApprovedLimit(params.stream_id).catch(() => {});
        return;
      case "$/cancel": {
        // The engine stopped waiting. Abort the provider call; its request is answered `cancelled`.
        this.abortByRequest.get(params.id)?.abort();
        return;
      }
      case "log":
        this.log(`engine ${params.level}: ${params.msg}`);
        return;
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
