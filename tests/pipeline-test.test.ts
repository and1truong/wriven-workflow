import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateResult } from "../src/tools/truncate.ts";
import { BINARY, REPO, startHost, startInProcess } from "./helpers.ts";

const EXAMPLE = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest.json"), "utf8"));
const FIXTURES = EXAMPLE.tests[0].fixtures;

describe("pipeline.test", () => {
  test("the example with three fixtures and a mock: one result, titles in the prompt, no state, nothing to the host", async () => {
    const { host, dir } = await startHost();
    const { tests: _tests, ...pipeline } = EXAMPLE;
    const result = await host.call("pipeline.test", { pipeline, fixtures: FIXTURES, llm: { mode: "mock", responses: ["Mocked digest."] } });
    expect(result.status).toBe("succeeded");
    expect(result.report.trigger).toBe("test");
    expect(result.report.stream_id).toBeNull();
    expect(result.report.sandbox).toBe("seatbelt");
    expect(result.results).toEqual([{ title: "Morning digest", body: "Mocked digest.", format: "markdown" }]);
    for (const title of ["Alpha a1", "Alpha a2", "Beta b1", "Gamma g1"]) expect(result.llm_requests[0].prompt).toContain(title);
    expect(result.llm_requests[0].step_id).toBe("summarize");
    expect(host.providerCalls).toEqual([]);
    expect(host.results).toEqual([]);
    expect(host.received.filter((m) => m.method === "host.llm" || m.method === "host.result" || m.method === "run.finished")).toEqual([]);
    expect(readdirSync(join(dir, "streams"))).toEqual([]);
    expect(existsSync(join(dir, "run-tmp")) ? readdirSync(join(dir, "run-tmp")) : []).toEqual([]);
    expect(result.report.state.committed).toBe(false);
  }, 30_000);

  test("echo is the default mode; mock responses repeat the last", async () => {
    const { host } = await startHost();
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Two calls",
      input: { type: "inject", messages: [{ data: { q: "one" } }, { data: { q: "two" } }, { data: { q: "three" } }] },
      processors: [{ id: "ask", type: "host_llm", prompt: "/q", target: "/a" }],
      output: { type: "host_result", title: "A", body: "/a" },
      limits: { llm_calls_per_run: 5, runs_per_day: 1, run_timeout: "1m" },
    };
    const echoed = await host.call("pipeline.test", { pipeline });
    expect(echoed.results.map((r: any) => r.body)).toEqual(["[mock reply] one", "[mock reply] two", "[mock reply] three"]);
    const mocked = await host.call("pipeline.test", { pipeline, llm: { mode: "mock", responses: ["x", "y"] } });
    expect(mocked.results.map((r: any) => r.body)).toEqual(["x", "y", "y"]);
  }, 30_000);

  test("input replaces what the input component emits", async () => {
    const { host } = await startHost();
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Note",
      input: { type: "host_trigger" },
      processors: [{ id: "note", type: "template", target: "/note", text: "Run {{/trigger}} from {{meta:origin}}" }],
      output: { type: "host_result", title: "Note", body: "/note" },
      limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
    };
    const result = await host.call("pipeline.test", { pipeline, input: { messages: [{ data: { trigger: "custom" }, meta: { origin: "test" } }] } });
    expect(result.results[0].body).toBe("Run custom from test");
  }, 30_000);

  test("network live against a host that does not allow it: permission_denied", async () => {
    const { host } = await startHost();
    const response = await host.request("pipeline.test", { pipeline: EXAMPLE, network: "live" });
    expect(response.error.data.kind).toBe("permission_denied");
  });

  test("a missing fixture under mock is fixture_missing, even with on_error skip", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: EXAMPLE, fixtures: {} });
    expect(result.status).toBe("failed");
    expect(result.report.error.kind).toBe("fixture_missing");
    expect(result.report.error.step_id).toBe("fetch");
  }, 30_000);

  test("a fixture redirect to an unlisted host is refused", async () => {
    const { host } = await startHost();
    const { on_error: _skip, ...fetch } = EXAMPLE.processors[0];
    const pipeline = { ...EXAMPLE, tests: undefined, processors: [{ ...fetch, urls: ["https://example.com/feed.xml"] }] };
    delete (pipeline as any).tests;
    pipeline.output = { type: "drop" };
    const result = await host.call("pipeline.test", { pipeline, fixtures: { "https://example.com/feed.xml": { status: 302, headers: { Location: "https://evil.example/x" } } } });
    expect(result.report.error.kind).toBe("permission_denied");
    expect(result.report.network.denied).toEqual(["evil.example"]);
  }, 30_000);

  test("the llm cap applies inside tests", async () => {
    const { host } = await startHost();
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Cap",
      input: { type: "inject", messages: [{ data: { q: "one" } }, { data: { q: "two" } }] },
      processors: [{ id: "ask", type: "host_llm", prompt: "/q", target: "/a" }],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 1, runs_per_day: 1, run_timeout: "1m" },
    };
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.report.error.kind).toBe("budget_exceeded");
    expect(result.llm_requests.length).toBe(1);
  }, 30_000);

  test("clock past remember re-admits keys; before it they stay seen", async () => {
    const { host } = await startHost();
    const state = { version: 1, seen: { new_only: { a1: "2026-11-01T00:00:00Z", a2: "2026-11-01T00:00:00Z", b1: "2026-11-01T00:00:00Z", g1: "2026-11-01T00:00:00Z" } } };
    const { tests: _tests, ...pipeline } = EXAMPLE;
    const soon = await host.call("pipeline.test", { pipeline, fixtures: FIXTURES, state, clock: "2026-11-03T00:00:00Z" });
    expect(soon.status).toBe("succeeded");
    expect(soon.results).toEqual([]);
    expect(soon.report.nothing_new).toBe(true);
    expect(soon.report.scheduled_for).toBe("2026-11-03T00:00:00Z");
    const later = await host.call("pipeline.test", { pipeline, fixtures: FIXTURES, state, clock: "2027-03-01T00:00:00Z" });
    expect(later.results.length).toBe(1);
  }, 30_000);

  test("inject is allowed here and refused in validate; invalid pipelines are invalid_pipeline", async () => {
    const { host } = await startHost();
    const response = await host.request("pipeline.test", { pipeline: { ...EXAMPLE, extra: 1 } });
    expect(response.error.data.kind).toBe("invalid_pipeline");
    expect(response.error.data.errors[0].path).toBe("/extra");
  });

  test("a bad llm param is invalid_params", async () => {
    const { host } = await startHost();
    const response = await host.request("pipeline.test", { pipeline: EXAMPLE, llm: { mode: "mock" } });
    expect(response.error.data.kind).toBe("invalid_params");
  });

  test("$/cancel of a test run answers with cancelled", async () => {
    const { host } = await startInProcess({ engine: { test: { hook: { delay_ms: 500 } } } });
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Slow",
      input: { type: "inject", messages: [{ data: { q: "x" } }] },
      processors: [],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
    };
    host.send({ jsonrpc: "2.0", id: "t-1", method: "pipeline.test", params: { pipeline } });
    await Bun.sleep(100);
    host.notify("$/cancel", { id: "t-1" });
    const response = await host.waitFor((m) => m.id === "t-1");
    expect(response.error.data.kind).toBe("cancelled");
  }, 30_000);

  test("a run's input larger than a public line does not stall; a prompt over the line limit fails the run", async () => {
    const { host } = await startInProcess({});
    // A 3 MiB string fits a public line; the prompt built from it twice does not.
    const body = "x".repeat(3 * 1024 * 1024);
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Big prompt",
      input: { type: "inject", messages: [{ data: { a: body } }] },
      processors: [
        { id: "prompt", type: "template", target: "/prompt", text: "{{/a}}{{/a}}" },
        { id: "ask", type: "host_llm", prompt: "/prompt", target: "/reply" },
      ],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 1, runs_per_day: 1, run_timeout: "1m" },
    };
    // A test tells the truth about it: the prompt would not fit a real host either.
    const tested = await host.call("pipeline.test", { pipeline });
    expect(tested.status).toBe("failed");
    expect(tested.report.error).toMatchObject({ kind: "invalid_request", reason: "message_too_large", step_id: "ask" });

    // Against a real host the prompt cannot fit a line: the run fails at once and says why.
    const { input: _input, ...stream } = pipeline;
    const created = await host.call("stream.create", {
      pipeline: { ...stream, name: "Big", input: { type: "host_trigger" }, processors: [
        { id: "seed", type: "template", target: "/a", text: "y".repeat(19_000) },
        { id: "double", type: "template", target: "/b", text: "{{/a}}".repeat(250) },
        { id: "ask", type: "host_llm", prompt: "/b", target: "/reply" },
      ] },
    });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
    expect(finished.params.report.status).toBe("failed");
    expect(finished.params.report.error).toMatchObject({ kind: "invalid_request", reason: "message_too_large", step_id: "ask" });
  }, 60_000);

  test("the sandbox requirement holds for tests", async () => {
    const { host } = await startHost({ env: { PATH: "/nonexistent" } });
    const response = await host.request("pipeline.test", { pipeline: EXAMPLE, fixtures: FIXTURES });
    expect(response.error.data.kind).toBe("sandbox_unavailable");
  });
});

describe("embedded tests", () => {
  test("run_embedded reports each", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: EXAMPLE, run_embedded: true });
    expect(result.status).toBe("passed");
    expect(result.tests.map((t: any) => [t.name, t.passed])).toEqual([
      ["new posts make one digest", true],
      ["a feed that is down is skipped and reported", true],
      ["a missing fixture is a mistake in the test", true],
      ["nothing new makes no call and no result", true],
    ]);
    expect(result.tool_result.passed).toBe(4);
  }, 60_000);

  test("a failing expectation says why", async () => {
    const { host } = await startHost();
    const pipeline = {
      ...EXAMPLE,
      tests: [{ name: "wrong", fixtures: FIXTURES, llm: { mode: "mock", responses: ["Text"] }, expect: { status: "succeeded", results_count: 2, result_body_contains: ["absent"], warnings_count: 1 } }],
    };
    const result = await host.call("pipeline.test", { pipeline, run_embedded: true });
    expect(result.status).toBe("failed");
    expect(result.tests[0].failures).toEqual(["1 results, expected 2", "0 warnings, expected 1", 'no result body contains "absent"']);
  }, 30_000);

  test("the CLI exits 0 on the example and non-zero on a failing test", () => {
    const out = Bun.spawnSync([BINARY, "test", join(REPO, "fixtures/pipelines/valid/feed-digest.json")], { stdout: "pipe", stderr: "pipe" });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.toString()).status).toBe("passed");
    const missing = Bun.spawnSync([BINARY, "test", "/nonexistent.json"], { stdout: "pipe", stderr: "pipe" });
    expect(missing.exitCode).toBe(2);
  }, 60_000);
});

describe("the agent surface", () => {
  test("initialize.tools: the eleven, each with a method that exists; no hash reaches the model", async () => {
    const { host, init } = await startHost();
    expect(init.tools.map((t: any) => t.name)).toEqual([
      "workflow_list_components", "workflow_validate_pipeline", "workflow_test_pipeline", "workflow_create_stream", "workflow_update_stream",
      "workflow_pause_stream", "workflow_resume_stream", "workflow_delete_stream", "workflow_list_streams", "workflow_get_stream", "workflow_run_now",
    ]);
    expect(init.host_tools_suggested[0].name).toBe("workflow_list_runs");
    for (const tool of init.tools) {
      const response = await host.request(tool.method, {});
      expect(response.error?.data.kind).not.toBe("method_not_found");
    }
    const created = await host.call("stream.create", { pipeline: EXAMPLE });
    expect(created.permissions_hash).toStartWith("sha256:");
    expect(JSON.stringify(created.tool_result)).not.toContain("sha256:");
    expect(created.tool_result.next).toContain("must approve");
    expect(created.tool_result.permission_sentences[0]).toBe("Runs: when Wriven asks.");
    const listed = await host.call("stream.list");
    expect(JSON.stringify(listed.tool_result)).not.toContain("sha256:");
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(JSON.stringify(got.tool_result)).not.toContain("sha256:");
    expect(got.tool_result.pipeline.name).toBe(EXAMPLE.name);
    const validated = await host.call("pipeline.validate", { pipeline: EXAMPLE });
    expect(validated.tool_result.permission_sentences.length).toBe(10);
  }, 60_000);

  test("create with an invalid pipeline: a typed error with paths", async () => {
    const { host } = await startHost();
    const response = await host.request("stream.create", { pipeline: { ...EXAMPLE, extra: 1 } });
    expect(response.error.data.kind).toBe("invalid_pipeline");
    expect(response.error.data.errors[0].path).toBe("/extra");
  });

  test("a large result comes back truncated, as JSON, with truncated: true", async () => {
    const { host } = await startHost();
    const { tests: _tests, ...pipeline } = EXAMPLE;
    const big = "lorem ipsum ".repeat(4000);
    const result = await host.call("pipeline.test", { pipeline, fixtures: FIXTURES, llm: { mode: "mock", responses: [big] } });
    expect(result.results[0].body.length).toBe(big.length);
    const serialized = JSON.stringify(result.tool_result);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32 * 1024);
    expect(result.tool_result.truncated).toBe(true);
    expect(result.tool_result.results[0].body.truncated).toBe(true);
    expect(result.tool_result.results[0].body.preview.length).toBe(2048);
    expect(result.tool_result.results[0].body.original_size).toBe(big.length);
  }, 30_000);
});

describe("truncation", () => {
  test("a small result is untouched", () => {
    const value = { a: "x" };
    expect(truncateResult(value, 1000)).toBe(value);
  });
  test("strings first, largest first", () => {
    const out: any = truncateResult({ small: "s".repeat(3000), big: "b".repeat(50_000), keep: "k" }, 32 * 1024);
    expect(out.big.truncated).toBe(true);
    expect(out.small).toBe("s".repeat(3000));
    expect(out.keep).toBe("k");
    expect(out.truncated).toBe(true);
  });
  test("then arrays lose their tails with a marker", () => {
    const out: any = truncateResult({ items: Array.from({ length: 5000 }, (_, i) => ({ i, name: `item-${i}` })) }, 32 * 1024);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(32 * 1024);
    const last = out.items.at(-1);
    expect(last.truncated).toBe(true);
    expect(last.omitted).toBe(5000 - (out.items.length - 1));
    expect(out.items[0].i).toBe(0);
  });
  test("a pipeline is never truncated", () => {
    const pipeline = { text: "p".repeat(40_000) };
    const out: any = truncateResult({ pipeline, other: "o".repeat(40_000) }, 50_000);
    expect(out.pipeline).toEqual(pipeline);
    expect(out.other.truncated).toBe(true);
  });
});
