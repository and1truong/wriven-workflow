import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPO, startHost } from "./helpers.ts";

const FILTERED = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest-filter.json"), "utf8"));
const { tests: _tests, ...PIPELINE } = FILTERED;
const URLS: string[] = PIPELINE.processors[0].urls;

const entry = (id: string, title: string) => ({ data: { id, title, link: `https://example.com/${id}` } });
const MOCKS = {
  fetch: { messages: [{ data: {} }] },
  parse: { messages: [entry("a1", "Alpha a1"), entry("a2", "Alpha a2"), entry("b1", "Beta b1")] },
  summarize: { replies: ["The digest."] },
};

const injected = (processors: unknown[], messages: unknown[], llmCalls = 5) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Mocked",
  input: { type: "inject", messages },
  processors,
  output: { type: "host_result", title: "A", body: "/a" },
  limits: { llm_calls_per_run: llmCalls, runs_per_day: 1, run_timeout: "1m" },
});

// Errors for one embedded test carrying `mocks`, as `code path`.
function mockErrors(mocks: unknown, pipeline: any = PIPELINE): string[] {
  const document = { ...pipeline, tests: [{ name: "t", mocks, expect: { status: "succeeded" } }] };
  return validatePipeline(document, { ...DEFAULT_VALIDATION_CONTEXT, testing: true }).errors.map((e) => `${e.code} ${e.path}`);
}

describe("test mocks: running", () => {
  test("mocked fetch and parse feed the real steps after them; host_llm answers from replies", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: PIPELINE, mocks: MOCKS });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["The digest."]);
    const steps = Object.fromEntries(result.report.steps.map((s: any) => [s.step_id, s]));
    expect(steps.fetch).toMatchObject({ in: 1, out: 3, mocked: true });
    expect(steps.parse).toMatchObject({ in: 3, out: 9, mocked: true });
    expect(steps.summarize).toMatchObject({ mocked: true });
    expect(steps.topic.mocked).toBeUndefined();
    expect(result.llm_requests).toHaveLength(1);
    expect(result.llm_requests[0].prompt).toContain("Alpha a1");
    expect(result.llm_requests[0].prompt).not.toContain("Beta b1");
    // No fixtures were given, so a fetch that ran would have failed with fixture_missing.
    expect(result.report.network.requests).toBe(0);
    expect(host.providerCalls).toEqual([]);
  }, 30_000);

  test("with network live, a mocked fetch still makes no request", async () => {
    const { host } = await startHost({ init: { capabilities: { llm: true, results: true, live_network_in_tests: true } } });
    const result = await host.call("pipeline.test", { pipeline: PIPELINE, mocks: MOCKS, network: "live" });
    expect(result.status).toBe("succeeded");
    expect(result.report.network).toMatchObject({ requests: 0, hosts: [] });
  }, 30_000);

  test("a mocked http_fetch sets meta source_url per URL and keeps the real ids", async () => {
    const { host } = await startHost();
    const pipeline = injected(
      [
        { id: "fetch", type: "http_fetch", urls: URLS },
        { id: "note", type: "template", target: "/a", text: "{{meta:source_url}} {{/content_type}} {{meta:tag}}" },
      ],
      [{ data: {} }],
      0,
    );
    const result = await host.call("pipeline.test", { pipeline, mocks: { fetch: { messages: [{ data: { content_type: "ok" }, meta: { tag: "t" } }] } } });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(URLS.map((url) => `${url} ok t`));
  }, 30_000);

  test("a step mock wins over llm; llm still answers steps without one", async () => {
    const { host } = await startHost();
    const pipeline = injected(
      [
        { id: "first", type: "host_llm", prompt: "/q", target: "/one" },
        { id: "second", type: "host_llm", prompt: "/q", target: "/two" },
        { id: "join", type: "template", target: "/a", text: "{{/one}} {{/two}}" },
      ],
      [{ data: { q: "question" } }],
    );
    const result = await host.call("pipeline.test", { pipeline, llm: { mode: "mock", responses: ["other"] }, mocks: { second: { replies: ["mocked", "again"] } } });
    expect(result.results.map((r: any) => r.body)).toEqual(["other mocked"]);
    expect(result.llm_requests.map((r: any) => r.step_id)).toEqual(["first", "second"]);
  }, 30_000);

  test("replies still count against llm_calls_per_run", async () => {
    const { host } = await startHost();
    const pipeline = injected([{ id: "ask", type: "host_llm", prompt: "/q", target: "/a" }], [{ data: { q: "one" } }, { data: { q: "two" } }], 1);
    const result = await host.call("pipeline.test", { pipeline, mocks: { ask: { replies: ["x"] } } });
    expect(result.status).toBe("failed");
    expect(result.report.error.kind).toBe("budget_exceeded");
    expect(result.llm_requests).toHaveLength(1);
  }, 30_000);

  test("a mocked container replaces all of it: nothing inside runs", async () => {
    const { host } = await startHost();
    const pipeline = injected(
      [
        {
          id: "each",
          type: "for_each",
          steps: [
            { id: "ask_prompt", type: "template", target: "/p", text: "{{/q}}" },
            { id: "ask", type: "host_llm", prompt: "/p", target: "/a" },
          ],
        },
      ],
      [{ data: { q: "one" } }, { data: { q: "two" } }],
    );
    const result = await host.call("pipeline.test", { pipeline, mocks: { each: { messages: [{ data: { q: "", p: "", a: "fixed" } }] } } });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["fixed", "fixed"]);
    expect(result.llm_requests).toEqual([]);
    expect(result.report.steps.filter((s: any) => s.parent === "each" && (s.invocations ?? 0) > 0)).toEqual([]);
  }, 30_000);

  test("embedded tests carry mocks; invalid params mocks come back with paths", async () => {
    const { host } = await startHost();
    const pipeline = { ...PIPELINE, tests: [{ name: "mocked", mocks: MOCKS, expect: { status: "succeeded", results_count: 1, result_body_contains: ["The digest."] } }] };
    const embedded = await host.call("pipeline.test", { pipeline, run_embedded: true });
    expect(embedded.status).toBe("passed");
    const bad = await host.request("pipeline.test", { pipeline: PIPELINE, mocks: { fetchh: { messages: [] } } });
    expect(bad.error.data.reason).toBe("invalid_mocks");
    expect(bad.error.data.errors.map((e: any) => `${e.code} ${e.path}`)).toEqual(["unknown_step /mocks/fetchh"]);
  }, 30_000);
});

describe("test mocks: validation", () => {
  test("the worked mocks are valid", () => {
    expect(mockErrors(MOCKS)).toEqual([]);
  });

  test("unknown steps and wrong outcomes", () => {
    expect(mockErrors({ fetchh: { messages: [] } })).toEqual(["unknown_step /tests/0/mocks/fetchh"]);
    expect(mockErrors({ parse: { replies: ["x"] } })).toEqual(["invalid_mock /tests/0/mocks/parse"]);
    expect(mockErrors({ summarize: { messages: [{ data: {} }] } })).toEqual(["invalid_mock /tests/0/mocks/summarize"]);
    expect(mockErrors({ parse: { messages: [], replies: ["x"] } })).toEqual(["invalid_mock /tests/0/mocks/parse"]);
    expect(mockErrors({ parse: { messages: Array.from({ length: 501 }, () => entry("a", "A")) } })).toEqual(["invalid_mock /tests/0/mocks/parse"]);
  });

  test("a field a later step reads must be in every message", () => {
    const errors = validatePipeline(
      { ...PIPELINE, tests: [{ name: "t", mocks: { ...MOCKS, parse: { messages: [entry("a1", "Alpha a1"), { data: { title: "Alpha a2" } }] } }, expect: { status: "succeeded" } }] },
      { ...DEFAULT_VALIDATION_CONTEXT, testing: true },
    ).errors;
    expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual(["mock_missing_field /tests/0/mocks/parse"]);
    expect(errors[0]!.message).toContain("/id");
    expect(errors[0]!.message).toContain("new_only");
  });

  test("fields the step does not emit, or of the wrong kind", () => {
    expect(mockErrors({ ...MOCKS, parse: { messages: [{ data: { id: "a", title: "A", score: 1 } }] } })).toEqual(["mock_shape_mismatch /tests/0/mocks/parse/messages/0/data/score"]);
    expect(mockErrors({ ...MOCKS, parse: { messages: [{ data: { id: "a", title: 3 } }] } })).toEqual(["mock_shape_mismatch /tests/0/mocks/parse/messages/0/data/title"]);
    expect(mockErrors({ ...MOCKS, parse: { messages: [{ data: { id: "a", title: "A", published: null, summary: null } }] } })).toEqual([]);
    expect(mockErrors({ ...MOCKS, fetch: { messages: [{ data: {}, meta: { source_url: "https://x.example/" } }] } })).toEqual(["mock_shape_mismatch /tests/0/mocks/fetch"]);
  });

  test("an id-preserving step emits at most one message", () => {
    expect(mockErrors({ ...MOCKS, prompt: { messages: [{ data: {} }, { data: {} }] } })).toEqual(["changes_message_ids /tests/0/mocks/prompt/messages"]);
  });

  test("a step inside a mocked container is unreachable", () => {
    const pipeline = injected([{ id: "each", type: "for_each", steps: [{ id: "inner", type: "template", target: "/a", text: "x" }] }], [{ data: {} }]);
    expect(mockErrors({ each: { messages: [{ data: { a: "x" } }] }, inner: { messages: [{ data: {} }] } }, pipeline)).toEqual(["mock_unreachable /tests/0/mocks/inner"]);
  });

  test("mocks never change the permissions", () => {
    const context = { ...DEFAULT_VALIDATION_CONTEXT, testing: true };
    const plain = validatePipeline(PIPELINE, context);
    const mocked = validatePipeline({ ...PIPELINE, tests: [{ name: "t", mocks: MOCKS, expect: { status: "succeeded" } }] }, context);
    expect(plain.valid && mocked.valid).toBe(true);
    if (plain.valid && mocked.valid) expect(mocked.permissions_hash).toBe(plain.permissions_hash);
  });
});
