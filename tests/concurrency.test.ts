import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { initParams, REPO, spawnHost, startHost, startInProcess, stateDir } from "./helpers.ts";

const TLS = join(REPO, "fixtures", "tls");
const CA = readFileSync(join(TLS, "ca.crt"), "utf8");
const URLS = Array.from({ length: 8 }, (_, i) => `https://example.com/p${i + 1}`);

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key: readFileSync(join(TLS, "server.key"), "utf8"), cert: readFileSync(join(TLS, "server.crt"), "utf8") },
    fetch: (request) => new Response(`page ${new URL(request.url).pathname}`, { headers: { "content-type": "text/plain" } }),
  });
});

afterAll(() => {
  server.stop(true);
});

const engineOptions = () => ({ test: { dial: () => ({ hostname: "127.0.0.1", port: server.port as number }), hook: { tls_ca: CA } } });

const pipeline = (calls: number, concurrency = 4) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Classify each",
  input: { type: "host_trigger" },
  processors: [
    { id: "fetch", type: "http_fetch", urls: URLS },
    {
      id: "each",
      type: "for_each",
      concurrency,
      steps: [
        { id: "ask_prompt", type: "template", target: "/p", text: "Q {{/body}}" },
        { id: "classify", type: "host_llm", prompt: "/p", target: "/a" },
      ],
    },
  ],
  output: { type: "host_result", title: "A", body: "/a" },
  limits: { llm_calls_per_run: calls, runs_per_day: 10, run_timeout: "1m" },
});

async function run(host: FakeHost, document: unknown): Promise<any> {
  const created = await host.call("stream.create", { pipeline: document });
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
  const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
  return finished.params.report;
}

describe("concurrent host.llm", () => {
  test("for_each concurrency 4 with llm_concurrency 4: four outstanding at most, eight calls, input order", async () => {
    const { host } = await startInProcess({ engine: engineOptions(), llm: { latency_ms: 150 }, init: { sandbox: "optional", capabilities: { llm: true, results: true, llm_concurrency: 4 } } });
    const report = await run(host, pipeline(8));
    expect(report.status).toBe("succeeded");
    expect(host.peakLlm).toBe(4);
    expect(host.providerCalls.length).toBe(8);
    expect(host.results.map((r) => r.result.body)).toEqual(URLS.map((u) => `[echo] Q page ${new URL(u).pathname}`));
  }, 30_000);

  test("without llm_concurrency from the host, one call at a time", async () => {
    const { host } = await startInProcess({ engine: engineOptions(), llm: { latency_ms: 50 }, init: { sandbox: "optional" } });
    const report = await run(host, pipeline(8));
    expect(report.status).toBe("succeeded");
    expect(host.peakLlm).toBe(1);
    expect(host.providerCalls.length).toBe(8);
  }, 30_000);

  test("the budget is reserved before sending: llm_calls_per_run 5 sends exactly 5", async () => {
    const { host } = await startInProcess({ engine: engineOptions(), llm: { latency_ms: 150 }, init: { sandbox: "optional", capabilities: { llm: true, results: true, llm_concurrency: 4 } } });
    const report = await run(host, pipeline(5));
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("budget_exceeded");
    expect(host.received.filter((m) => m.method === "host.llm").length).toBe(5);
    expect(report.llm.calls).toBe(5);
  }, 30_000);

  test("a failure while siblings are with the host cancels each outstanding call", async () => {
    const { host } = await startInProcess({ engine: engineOptions(), llm: { mode: "hold" }, init: { sandbox: "optional", capabilities: { llm: true, results: true, llm_concurrency: 4 } } });
    const report = await run(host, pipeline(2));
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({ kind: "budget_exceeded", step_id: "classify" });
    const sent = host.received.filter((m) => m.method === "host.llm").map((m) => m.id);
    expect(sent.length).toBe(2);
    const cancelled = host.received.filter((m) => m.method === "$/cancel").map((m) => m.params.id);
    expect(cancelled.sort()).toEqual(sent.sort());
  }, 30_000);

  test("initialize refuses an llm_concurrency outside 1 to 8", async () => {
    const fresh = spawnHost();
    const response = await fresh.request("initialize", initParams(stateDir(), { capabilities: { llm: true, results: true, llm_concurrency: 9 } }));
    expect(response.error.data).toMatchObject({ kind: "invalid_params", reason: "invalid_capabilities" });
  }, 30_000);

  test("pipeline.test clamps concurrency to 1 and says so; mock replies come in input order", async () => {
    const { host } = await startHost();
    const fixtures = Object.fromEntries(URLS.map((u) => [u, { status: 200, content_type: "text/plain", body: `page ${new URL(u).pathname}` }]));
    const result = await host.call("pipeline.test", { pipeline: pipeline(8), fixtures, llm: { mode: "mock", responses: URLS.map((_, i) => `r${i + 1}`) } });
    expect(result.status).toBe("succeeded");
    expect(result.clamped).toEqual(["for_each:each"]);
    expect(result.results.map((r: any) => r.body)).toEqual(URLS.map((_, i) => `r${i + 1}`));
    expect(result.llm_requests.map((r: any) => r.message_id)).toEqual(URLS.map((_, i) => `m1.${i}`));
  }, 30_000);
});
