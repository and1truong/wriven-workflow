import { describe, expect, test } from "bun:test";
import { derivePermissions } from "../src/pipeline/permissions.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { startHost } from "./helpers.ts";

const CTX = { ...DEFAULT_VALIDATION_CONTEXT, testing: true };
const notOk = { not: { field: "/a", equals: "ok" } };
const askSteps = [
  { id: "p", type: "template", target: "/p", text: "Try {{/q}}" },
  { id: "ask", type: "host_llm", prompt: "/p", target: "/a" },
];

const doc = (loop: Record<string, unknown>, input: unknown = { type: "inject", messages: [{ data: { q: "one" } }] }) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Loop",
  input,
  processors: [{ id: "until_ok", type: "while", repeat_while: notOk, steps: askSteps, max_loops: 3, at_least_once: true, ...loop }],
  output: { type: "drop" },
  limits: { llm_calls_per_run: 10, runs_per_day: 2, run_timeout: "1m" },
});

const keys = (report: any) => report.llm.requests.map((r: any) => r.idempotency_key.split("/").slice(1).join("/"));

describe("while at run time", () => {
  test("replies that never satisfy the condition: three calls with iteration keys, then loop_limit", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: doc({}), llm: { mode: "mock", responses: ["nope"] } });
    expect(keys(result.report)).toEqual(["ask@1/m1", "ask@2/m1", "ask@3/m1"]);
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "loop_limit", step_id: "until_ok", message_id: "m1" });
  }, 30_000);

  test("on_limit continue: the run succeeds with one loop_limit warning per message", async () => {
    const { host } = await startHost();
    const input = { type: "inject", messages: [{ data: { q: "one" } }, { data: { q: "two" } }] };
    const result = await host.call("pipeline.test", { pipeline: doc({ on_limit: "continue" }, input), llm: { mode: "mock", responses: ["nope"] } });
    expect(result.status).toBe("succeeded");
    expect(result.report.warnings.map((w: any) => `${w.code}:${w.message_id}`)).toEqual(["loop_limit:m1", "loop_limit:m2"]);
  }, 30_000);

  test("a reply that satisfies the condition ends the loop for that message", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: doc({}), llm: { mode: "mock", responses: ["nope", "ok"] } });
    expect(result.status).toBe("succeeded");
    expect(keys(result.report)).toEqual(["ask@1/m1", "ask@2/m1"]);
  }, 30_000);

  test("nested loops carry both iterations, outermost first", async () => {
    const { host } = await startHost();
    const inner = { id: "inner", type: "while", repeat_while: { field: "/q", exists: true }, steps: askSteps, max_loops: 1, at_least_once: true, on_limit: "continue" };
    const pipeline = doc({ id: "outer", repeat_while: { field: "/q", exists: true }, steps: [inner], max_loops: 2, on_limit: "continue" });
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.status).toBe("succeeded");
    expect(keys(result.report)).toEqual(["ask@1.1/m1", "ask@2.1/m1"]);
  }, 30_000);

  test("a lost response inside a loop repeats the same iteration key with attempt 2", async () => {
    const { host } = await startHost({ init: { sandbox: "optional", timeouts: { host_response: "1s" } }, llm: { responses: ["ok"], drop_responses: 1 } });
    const pipeline = doc({ steps: [{ id: "p", type: "template", target: "/p", text: "Try {{/run_id}}" }, askSteps[1]] }, { type: "host_trigger" });
    const created = await host.call("stream.create", { pipeline });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
    expect(finished.params.report.status).toBe("succeeded");
    const sent = host.received.filter((m) => m.method === "host.llm").map((m) => [m.params.idempotency_key, m.params.attempt]);
    expect(sent).toEqual([
      [`${run_id}/ask@1/m1`, 1],
      [`${run_id}/ask@1/m1`, 2],
    ]);
    expect(host.providerCalls.length).toBe(1);
  }, 30_000);

  test("at_least_once runs the body once even when the condition starts false; a dropped message leaves", async () => {
    const { host } = await startHost();
    const once = await host.call("pipeline.test", { pipeline: doc({ repeat_while: { field: "/q", equals: "never" } }) });
    expect(keys(once.report)).toEqual(["ask@1/m1"]);
    const checkedFirst = await host.call("pipeline.test", { pipeline: doc({ repeat_while: { field: "/q", equals: "never" }, at_least_once: false }) });
    expect(keys(checkedFirst.report)).toEqual([]);
    const input = { type: "inject", messages: [{ data: { q: "keep" } }, { data: { q: "drop" } }] };
    const dropping = doc({ steps: [{ id: "only_keep", type: "filter", keep_if: { field: "/q", equals: "keep" } }, ...askSteps] }, input);
    (dropping as any).output = { type: "host_result", title: "T", body: "/q" };
    const dropped = await host.call("pipeline.test", { pipeline: dropping, llm: { mode: "mock", responses: ["ok"] } });
    expect(dropped.status).toBe("succeeded");
    expect(dropped.results.map((r: any) => r.body)).toEqual(["keep"]);
  }, 30_000);
});

describe("while validation", () => {
  const codes = (document: unknown) => validatePipeline(document, CTX).errors.map((e) => `${e.code} ${e.path}`);

  test("a body that makes new ids is changes_message_ids", () => {
    expect(codes(doc({ steps: [{ id: "each", type: "split", field: "/q" }, ...askSteps] }))).toEqual(["changes_message_ids /processors/0/steps/0/type"]);
    expect(codes(doc({ steps: [{ id: "inner", type: "for_each", steps: [{ id: "all", type: "collect" }] }] }))).toContain("changes_message_ids /processors/0/steps/0/type");
  });

  test("max_loops is required and bounded; sleeps multiply by it", () => {
    const { max_loops: _m, ...rest } = doc({}).processors[0] as any;
    expect(codes({ ...doc({}), processors: [rest] })).toEqual(["schema /processors/0/max_loops"]);
    expect(codes(doc({ max_loops: 21 }))).toEqual(["schema /processors/0/max_loops"]);
    const sleepy = { ...doc({ steps: [{ id: "nap", type: "sleep", duration: "5m" }, ...askSteps] }), limits: { llm_calls_per_run: 10, runs_per_day: 2, run_timeout: "10m" } };
    expect(codes(sleepy)).toEqual(["sleep_exceeds_timeout /processors/0/steps/0/duration"]);
    const short = { ...sleepy, processors: [{ ...sleepy.processors[0], max_loops: 1 }] };
    expect(codes(short)).toEqual([]);
  });

  test("a fetch anywhere in a while body counts as preceding its model calls", () => {
    // Validation keeps http_fetch out of a while body today (it makes new ids), so the rule is
    // checked on the derivation directly, for a component that fetches and keeps ids later.
    const loop = {
      ...doc({ steps: [{ id: "ask", type: "host_llm", prompt: "/run_id", target: "/a" }, { id: "fetch", type: "http_fetch", urls: ["https://example.com/a"] }] }, { type: "host_trigger" }),
    };
    expect(derivePermissions(loop).llm?.receives_fetched_content).toBe(true);
    const outside = { ...loop, processors: [...loop.processors.map((p: any) => ({ ...p, steps: [p.steps[0]] })), { id: "fetch", type: "http_fetch", urls: ["https://example.com/a"] }] };
    expect(derivePermissions(outside).llm?.receives_fetched_content).toBe(false);
  });

});
