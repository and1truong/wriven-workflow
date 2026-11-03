import { describe, expect, test } from "bun:test";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { REPORT_SCHEMA } from "../src/report.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { initParams, spawnHost, startHost, startInProcess, stateDir } from "./helpers.ts";

const llmPipeline = (limits: Record<string, unknown> = {}, steps = 1) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Calls",
  input: { type: "host_trigger" },
  processors: [
    { id: "prompt", type: "template", target: "/prompt", text: "Hello" },
    ...Array.from({ length: steps }, (_, i) => ({ id: `ask${i}`, type: "host_llm", prompt: "/prompt", target: "/reply" })),
  ],
  output: { type: "host_result", title: "T", body: "/reply" },
  limits: { llm_calls_per_run: steps, runs_per_day: 2, run_timeout: "5m", ...limits },
});

async function approved(host: FakeHost, pipeline: unknown): Promise<string> {
  const created = await host.call("stream.create", { pipeline });
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  return created.stream_id;
}

async function runOnce(host: FakeHost, id: string): Promise<any> {
  const { run_id } = await host.call("run.trigger", { stream_id: id });
  const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
  return finished.params.report;
}

describe("runs_per_day", () => {
  test("the third trigger in 24 hours is skipped with resets_at; past the window it runs again", async () => {
    let now = new Date("2026-11-03T08:00:00Z");
    const { host } = await startInProcess({ engine: { now: () => now } });
    const id = await approved(host, llmPipeline());
    expect((await runOnce(host, id)).status).toBe("succeeded");
    now = new Date("2026-11-03T09:00:00Z");
    expect((await runOnce(host, id)).status).toBe("succeeded");
    now = new Date("2026-11-03T10:00:00Z");
    const skipped = await runOnce(host, id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.started_at).toBeNull();
    expect(skipped.error.kind).toBe("runs_per_day_exceeded");
    expect(skipped.resets_at).toBe("2026-11-04T08:00:00.000Z");
    expect(skipped.error.resets_at).toBe("2026-11-04T08:00:00.000Z");
    expect(checkSchema(REPORT_SCHEMA, skipped)).toEqual([]);
    expect(host.providerCalls.length).toBe(2);
    expect(host.notifications("run.started").length).toBe(2);
    now = new Date("2026-11-04T08:00:01Z");
    expect((await runOnce(host, id)).status).toBe("succeeded");
    now = new Date("2026-11-04T08:00:02Z");
    expect((await runOnce(host, id)).status).toBe("skipped");
    now = new Date("2026-11-04T09:00:01Z");
    expect((await runOnce(host, id)).status).toBe("succeeded");
  }, 60_000);

  test("failures count; the count survives a restart; a skipped run is not counted", async () => {
    let now = new Date("2026-11-03T08:00:00Z");
    const { host, dir } = await startInProcess({ engine: { now: () => now }, llm: { error: { kind: "provider_unavailable", message: "Down." } } });
    const id = await approved(host, llmPipeline({ runs_per_day: 1 }));
    expect((await runOnce(host, id)).status).toBe("failed");
    host.closeStdin();
    await host.exited;
    const again = await startInProcess({ dir, engine: { now: () => now } });
    expect((await runOnce(again.host, id)).status).toBe("skipped");
    expect((await runOnce(again.host, id)).status).toBe("skipped");
    now = new Date("2026-11-04T08:00:01Z");
    expect((await runOnce(again.host, id)).status).toBe("succeeded");
  }, 60_000);

  test("each stream has its own count; tests do not count", async () => {
    const { host } = await startInProcess({ engine: { now: () => new Date("2026-11-03T08:00:00Z") } });
    const one = await approved(host, llmPipeline({ runs_per_day: 1 }));
    const two = await approved(host, llmPipeline({ runs_per_day: 1 }));
    await host.call("pipeline.test", { pipeline: llmPipeline({ runs_per_day: 1 }) });
    expect((await runOnce(host, one)).status).toBe("succeeded");
    expect((await runOnce(host, two)).status).toBe("succeeded");
    expect((await runOnce(host, one)).status).toBe("skipped");
  }, 60_000);
});

describe("cost", () => {
  const INIT = { capabilities: { llm: true, llm_reports_cost: true, results: true } };

  test("cost past the cap stops the run with budget_exceeded and no further calls", async () => {
    const { host } = await startInProcess({ init: INIT, llm: { responses: ["a"], cost_usd: 0.06 } });
    const id = await approved(host, llmPipeline({ llm_cost_per_run_usd: 0.1 }, 3));
    const report = await runOnce(host, id);
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({ kind: "budget_exceeded", limit: "llm_cost_per_run_usd", step_id: "ask1" });
    expect(report.error.value).toBeCloseTo(0.12);
    expect(host.providerCalls.length).toBe(2);
    expect(report.llm.cost_usd).toBeCloseTo(0.12);
    expect(host.results.length).toBe(0);
  }, 30_000);

  test("under the cap the run succeeds and the report sums cost", async () => {
    const { host } = await startInProcess({ init: INIT, llm: { responses: ["a"], cost_usd: 0.02 } });
    const id = await approved(host, llmPipeline({ llm_cost_per_run_usd: 0.1 }, 3));
    const report = await runOnce(host, id);
    expect(report.status).toBe("succeeded");
    expect(report.llm.cost_usd).toBeCloseTo(0.06);
    expect(report.llm.input_tokens).toBe(15);
  }, 30_000);

  test("a host that cannot report cost: the sentence says so and nothing is enforced", async () => {
    const { host } = await startInProcess({ llm: { responses: ["a"], cost_usd: 9 } });
    const created = await host.call("stream.create", { pipeline: llmPipeline({ llm_cost_per_run_usd: 0.1 }) });
    expect(created.rendered).toContain("Cost limit: not enforceable with this provider.");
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    expect((await runOnce(host, created.stream_id)).status).toBe("succeeded");
  }, 30_000);

  test("a host that can: the other sentence, and small amounts stay readable", () => {
    const render = (cost: number) => {
      const result = validatePipeline(llmPipeline({ llm_cost_per_run_usd: cost }), { ...DEFAULT_VALIDATION_CONTEXT, llmReportsCost: true });
      if (!result.valid) throw new Error("invalid");
      return result.rendered;
    };
    expect(render(0.1)).toContain("Stops a run that would cost more than $0.10, when the provider reports cost.");
    expect(render(0.005)).toContain("Stops a run that would cost more than $0.0050, when the provider reports cost.");
  });

  test("the host's own budget_exceeded ends the run", async () => {
    const { host } = await startHost({ init: { sandbox: "optional" }, llm: { error: { kind: "budget_exceeded", message: "The host's count says stop.", limit: "llm_calls_per_run", value: 1 } } });
    const id = await approved(host, llmPipeline());
    const report = await runOnce(host, id);
    expect(report.error).toMatchObject({ kind: "budget_exceeded", limit: "llm_calls_per_run", value: 1 });
  }, 30_000);
});

describe("host ceilings", () => {
  test("100 at initialize is an error", async () => {
    const host = spawnHost();
    const response = await host.request("initialize", initParams(stateDir(), { ceilings: { llm_calls_per_run: 100 } }));
    expect(response.error.data.kind).toBe("invalid_params");
    expect(response.error.data.reason).toBe("ceiling_above_compiled");
  });

  test("10 at initialize: a pipeline asking for 11 fails validation", async () => {
    const { host } = await startHost({ init: { ceilings: { llm_calls_per_run: 10 } } });
    const result = await host.call("pipeline.validate", { pipeline: llmPipeline({ llm_calls_per_run: 11 }) });
    expect(result.errors[0]).toMatchObject({ code: "limit_out_of_range", path: "/limits/llm_calls_per_run" });
    const fine = await host.call("pipeline.validate", { pipeline: llmPipeline({ llm_calls_per_run: 10 }) });
    expect(fine.valid).toBe(true);
  });

  test("run_timeout and runs_per_day ceilings; an unknown ceiling is an error", async () => {
    const { host } = await startHost({ init: { ceilings: { run_timeout: "1m", runs_per_day: 3 } } });
    const result = await host.call("pipeline.validate", { pipeline: llmPipeline({ run_timeout: "2m", runs_per_day: 4 }) });
    expect(result.errors.map((e: any) => e.path).sort()).toEqual(["/limits/run_timeout", "/limits/runs_per_day"]);
    const other = spawnHost();
    const response = await other.request("initialize", initParams(stateDir(), { ceilings: { nonsense: 1 } }));
    expect(response.error.data.reason).toBe("invalid_ceilings");
  });

  test("a stream approved before a lower ceiling keeps to the lower one at run time", async () => {
    const now = () => new Date("2026-11-03T08:00:00Z");
    const first = await startInProcess({ engine: { now } });
    const id = await approved(first.host, llmPipeline({ llm_calls_per_run: 3, runs_per_day: 5 }, 3));
    first.host.closeStdin();
    await first.host.exited;
    const lowered = await startInProcess({ dir: first.dir, init: { ceilings: { llm_calls_per_run: 1, runs_per_day: 1 } }, engine: { now } });
    const report = await runOnce(lowered.host, id);
    expect(report.error).toMatchObject({ kind: "budget_exceeded", value: 1 });
    expect(lowered.host.providerCalls.length).toBe(1);
    expect((await runOnce(lowered.host, id)).status).toBe("skipped");
  }, 30_000);
});
