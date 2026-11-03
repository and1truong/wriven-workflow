// `pipeline.test`: one run in a sandboxed run process with the world replaced. Never writes state and
// never calls the real host for host.llm or host.result.

import { RpcError } from "../protocol/errors.ts";
import type { Message } from "../executor/messages.ts";
import type { StateFile } from "../executor/run-state.ts";
import type { Permissions } from "../pipeline/permissions.ts";
import type { RunReport } from "../report.ts";
import { allSteps } from "../pipeline/tree.ts";
import { RunProcess, type RunJob, type SupervisorEnv } from "../supervisor/supervisor.ts";
import { truncateResult } from "../tools/truncate.ts";

// Well under the line limit; a test's prompts and results come back in full unless they are huge.
const MAX_TEST_RESULT_BYTES = 3 * 1024 * 1024;

export interface TestParams {
  pipeline: any;
  permissions: Permissions;
  permissions_hash: string;
  input?: { messages?: Array<{ data: unknown; meta?: Record<string, string> }> };
  llm?: { mode?: "mock" | "echo"; responses?: string[] };
  fixtures?: Record<string, { status?: number; content_type?: string; body?: string; headers?: Record<string, string> }>;
  network?: "mock" | "live";
  clock?: string;
  state?: StateFile;
}

export interface TestOutcome {
  status: RunReport["status"];
  report: RunReport;
  results: Array<{ title: string; body: string; format: string }>;
  llm_requests: Array<{ step_id: string; message_id: string; system?: string; prompt: string }>;
  logs: NonNullable<RunReport["logs"]>;
  // Steps whose concurrency ran at 1 here, so mock replies came in a fixed order: "for_each:<id>".
  clamped: string[];
}

export function clampedSteps(pipeline: any): string[] {
  return allSteps(pipeline)
    .filter((s) => s.config.type === "for_each" && (s.config.concurrency ?? 1) > 1)
    .map((s) => `${s.config.type}:${s.config.id}`);
}

function checkParams(params: TestParams): void {
  const invalid = (message: string, reason: string) => new RpcError("invalid_params", message, { reason });
  if (params.llm !== undefined) {
    const { mode, responses } = params.llm;
    if (mode !== undefined && mode !== "mock" && mode !== "echo") throw invalid('llm.mode must be "mock" or "echo".', "invalid_llm");
    if (mode === "mock" && (!Array.isArray(responses) || responses.length === 0 || responses.some((r) => typeof r !== "string"))) {
      throw invalid("llm.responses must be a list of strings when llm.mode is mock.", "invalid_llm");
    }
  }
  if (params.clock !== undefined && (typeof params.clock !== "string" || Number.isNaN(Date.parse(params.clock)))) {
    throw invalid("clock must be an RFC 3339 instant.", "invalid_clock");
  }
  if (params.network !== undefined && params.network !== "mock" && params.network !== "live") {
    throw invalid('network must be "mock" or "live".', "invalid_network");
  }
  if (params.input !== undefined && !Array.isArray(params.input.messages)) {
    throw invalid("input must be { messages: [{ data, meta? }] }.", "invalid_input");
  }
}

export async function runPipelineTest(params: TestParams, env: SupervisorEnv, signal: AbortSignal, track: (process: RunProcess, active: boolean) => void): Promise<TestOutcome> {
  checkParams(params);
  const results: TestOutcome["results"] = [];
  const llmRequests: TestOutcome["llm_requests"] = [];
  const responses = params.llm?.mode === "mock" ? params.llm.responses! : null;
  let answered = 0;
  const overrides: Message[] | null = params.input?.messages
    ? params.input.messages.map((m, i) => ({ id: `m${i + 1}`, data: structuredClone(m.data), meta: { ...m.meta } }))
    : null;
  const now = env.now().toISOString();
  const job: RunJob = {
    run_id: Bun.randomUUIDv7(),
    stream_id: null,
    stream_name: params.pipeline.name,
    pipeline: params.pipeline,
    permissions_hash: params.permissions_hash,
    permissions: params.permissions,
    trigger: "test",
    scheduled_for: params.clock ?? null,
    queued_at: now,
    clock: params.clock ?? (env.injectClock ? now : null),
    input_override: overrides,
    fixtures: params.network === "live" ? null : (params.fixtures ?? {}),
    initial_state: params.state ?? { version: 1, seen: {} },
  };
  const process = new RunProcess(job, {
    ...env,
    hostHandlers: {
      async llm(request: any) {
        const prompt: string = request.messages[0].content;
        llmRequests.push({ step_id: request.step_id, message_id: request.message_id, ...(request.system !== undefined ? { system: request.system } : {}), prompt });
        const text = responses ? responses[Math.min(answered++, responses.length - 1)]! : `[mock reply] ${prompt}`;
        return { text, usage: { input_tokens: 0, output_tokens: 0 }, provider: "mock", model: "mock", finished: "stop" };
      },
      async result(request: any) {
        results.push(request.result);
        return { accepted: true };
      },
    },
  });
  track(process, true);
  const onAbort = () => process.cancel("test_cancelled");
  signal.addEventListener("abort", onAbort);
  try {
    const report = await process.run();
    if (signal.aborted) throw new RpcError("cancelled", "The test was cancelled.", { reason: "cancelled" });
    return truncateResult({ status: report.status, report, results, llm_requests: llmRequests, logs: report.logs ?? [], clamped: clampedSteps(params.pipeline) }, MAX_TEST_RESULT_BYTES);
  } finally {
    signal.removeEventListener("abort", onAbort);
    track(process, false);
  }
}

export interface EmbeddedTest {
  name: string;
  input?: TestParams["input"];
  llm?: TestParams["llm"];
  fixtures?: TestParams["fixtures"];
  network?: TestParams["network"];
  clock?: string;
  state?: StateFile;
  expect: {
    status: RunReport["status"];
    results_count?: number;
    result_body_contains?: string[];
    warnings_count?: number;
    error_kind?: string;
    logs_contain?: string[];
  };
}

// Why an outcome does not meet what the test expected. Empty means it passed.
export function checkExpectations(outcome: TestOutcome, expect: EmbeddedTest["expect"]): string[] {
  const failures: string[] = [];
  const { report, results } = outcome;
  if (outcome.status !== expect.status) failures.push(`status is ${outcome.status}, expected ${expect.status}${report.error ? ` (${report.error.kind}: ${report.error.message})` : ""}`);
  if (expect.results_count !== undefined && results.length !== expect.results_count) failures.push(`${results.length} results, expected ${expect.results_count}`);
  if (expect.warnings_count !== undefined && report.warnings.length !== expect.warnings_count) failures.push(`${report.warnings.length} warnings, expected ${expect.warnings_count}`);
  if (expect.error_kind !== undefined && report.error?.kind !== expect.error_kind) failures.push(`error kind is ${report.error?.kind ?? "none"}, expected ${expect.error_kind}`);
  for (const text of expect.logs_contain ?? []) {
    if (!(report.logs ?? []).some((l) => l.text.includes(text))) failures.push(`no log line contains ${JSON.stringify(text)}`);
  }
  for (const text of expect.result_body_contains ?? []) {
    if (!results.some((r) => typeof r.body === "string" && r.body.includes(text))) failures.push(`no result body contains ${JSON.stringify(text)}`);
  }
  return failures;
}
