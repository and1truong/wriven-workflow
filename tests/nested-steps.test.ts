import { describe, expect, test } from "bun:test";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { pipelineSchema } from "../src/pipeline/schema.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPORT_SCHEMA } from "../src/report.ts";
import { startHost } from "./helpers.ts";

const CTX = { ...DEFAULT_VALIDATION_CONTEXT, testing: true };

const doc = (processors: unknown[], extra: Record<string, unknown> = {}) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Nested",
  input: { type: "inject", messages: [{ data: { q: "one" } }, { data: { q: "two" } }, { data: { q: "three" } }] },
  processors,
  output: { type: "host_result", title: "A", body: "/a" },
  limits: { llm_calls_per_run: 5, runs_per_day: 1, run_timeout: "1m" },
  ...extra,
});

const classifyEach = (steps?: unknown[]) => ({
  id: "each",
  type: "for_each",
  steps: steps ?? [
    { id: "ask_prompt", type: "template", target: "/p", text: "Classify {{/q}}" },
    { id: "classify", type: "host_llm", prompt: "/p", target: "/a" },
  ],
});

const codes = (document: unknown) => validatePipeline(document, CTX).errors.map((e) => `${e.code} ${e.path}`);

describe("for_each at run time", () => {
  test("runs the steps per message in order, keeps v0 keys, and reports nested steps", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: doc([classifyEach()]) });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["[mock reply] Classify one", "[mock reply] Classify two", "[mock reply] Classify three"]);
    expect(result.llm_requests.map((r: any) => `${r.step_id}/${r.message_id}`)).toEqual(["classify/m1", "classify/m2", "classify/m3"]);
    expect(result.report.llm.requests.map((r: any) => r.idempotency_key.split("/").slice(1).join("/"))).toEqual(["classify/m1", "classify/m2", "classify/m3"]);
    const steps = result.report.steps.map(({ duration_ms: _d, ...s }: any) => s);
    expect(steps).toEqual([
      { step_id: "input", in: 0, out: 3, dropped: 0 },
      { step_id: "each", in: 3, out: 3, dropped: 0 },
      { step_id: "ask_prompt", in: 3, out: 3, dropped: 0, parent: "each", invocations: 3 },
      { step_id: "classify", in: 3, out: 3, dropped: 0, parent: "each", invocations: 3 },
      { step_id: "output", in: 3, out: 3, dropped: 0 },
    ]);
    expect(checkSchema(REPORT_SCHEMA, result.report)).toEqual([]);
  }, 30_000);

  test("a failure on message 2 fails the run with the nested step and that message", async () => {
    const { host } = await startHost();
    const pipeline = doc([classifyEach([{ id: "ask_prompt", type: "template", target: "/p", text: "{{/q}} {{/extra}}" }, { id: "classify", type: "host_llm", prompt: "/p", target: "/a" }])]);
    pipeline.input = { type: "inject", messages: [{ data: { q: "one", extra: "x" } }, { data: { q: "two" } }, { data: { q: "three", extra: "y" } }] } as any;
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "unresolved_pointer", step_id: "ask_prompt", message_id: "m2" });
    expect(result.llm_requests.length).toBe(1);
  }, 30_000);
});

describe("validation of nested steps", () => {
  test("a nested pipeline validates, and the published schema accepts it", () => {
    const document = doc([classifyEach()]);
    expect(codes(document)).toEqual([]);
    expect(checkSchema(pipelineSchema(), document)).toEqual([]);
  });

  test("schema errors inside a container carry the nested path", () => {
    expect(codes(doc([classifyEach([{ id: "bad", type: "template", target: "/p" }])]))).toEqual(["schema /processors/0/steps/0/text"]);
    expect(codes(doc([classifyEach([{ id: "bad", type: "nope" }])]))).toEqual(["schema /processors/0/steps/0/type"]);
    expect(codes(doc([{ id: "each", type: "for_each", steps: [] }]))).toEqual(["schema /processors/0/steps"]);
  });

  test("shapes flow through nested steps", () => {
    expect(codes(doc([classifyEach([{ id: "t", type: "template", target: "/p", text: "{{/missing}}" }])]))).toEqual([]);
    const fromTrigger = { ...doc([classifyEach([{ id: "t", type: "template", target: "/p", text: "{{/missing}}" }])]), input: { type: "host_trigger" } };
    expect(codes(fromTrigger)).toContain("unresolved_pointer /processors/0/steps/0/text");
  });

  test("a duplicate id between a nested and a top-level step is duplicate_id", () => {
    expect(codes(doc([classifyEach(), { id: "classify", type: "template", target: "/x", text: "y" }]))).toEqual(["duplicate_id /processors/1/id"]);
  });

  test("depth 5 is nesting_too_deep; 65 steps are too_many_steps", () => {
    const leaf = { id: "leaf", type: "template", target: "/a", text: "x" };
    const nest = (depth: number): any => (depth === 0 ? leaf : { id: `n${depth}`, type: "for_each", steps: [nest(depth - 1)] });
    expect(codes(doc([nest(4)]))).toEqual([]);
    expect(codes(doc([nest(5)]))).toEqual(["nesting_too_deep /processors/0/steps/0/steps/0/steps/0/steps/0/steps/0"]);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, type: "template", target: "/a", text: "x" }));
    expect(codes(doc([{ id: "each", type: "for_each", steps: many(63) }]))).toEqual([]);
    expect(codes(doc([{ id: "each", type: "for_each", steps: many(64) }]))).toEqual(["too_many_steps /processors"]);
  });

  test("collect inside for_each validates with a per_message_context warning", () => {
    const result = validatePipeline(doc([classifyEach([{ id: "all", type: "collect" }, { id: "t", type: "template", target: "/a", text: "{{/count}}" }])]), CTX);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => `${w.code} ${w.path}`)).toEqual(["per_message_context /processors/0/steps/0/type"]);
  });

  test("a nested fetch before a host_llm sends fetched content; a nested host_llm needs the capability", () => {
    const fetching = {
      ...doc([
        { id: "each", type: "for_each", steps: [{ id: "fetch", type: "http_fetch", urls: ["https://example.com/a"] }] },
        { id: "ask", type: "host_llm", prompt: "/body", target: "/a" },
      ]),
      input: { type: "host_trigger" },
    };
    const result = validatePipeline(fetching, CTX);
    if (!result.valid) throw new Error(JSON.stringify(result.errors));
    expect(result.permissions.llm?.receives_fetched_content).toBe(true);
    expect(result.permissions.network.map((n) => n.host)).toEqual(["example.com"]);
    const noLlm = validatePipeline(doc([classifyEach()]), { ...CTX, capabilities: { llm: false, results: true } });
    expect(noLlm.errors.map((e) => `${e.code} ${e.path}`)).toEqual(["capability_missing /processors/0/steps/1/type"]);
  });

  test("components.list reports the structure limits", async () => {
    const { host } = await startHost();
    const listed = await host.call("components.list");
    expect(listed.structure).toEqual({ nesting_depth: 4, steps: 64 });
    expect(listed.components.find((c: any) => c.type === "for_each").schema.properties.steps.items).toEqual({ $ref: "#/$defs/processor" });
  }, 30_000);
});
