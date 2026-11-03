import { describe, expect, test } from "bun:test";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { startHost } from "./helpers.ts";

const pipeline = (messages: unknown[], processors: unknown[], output: unknown = { type: "drop" }, limits: Record<string, unknown> = {}) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Leaf",
  input: { type: "inject", messages: messages.map((data) => ({ data })) },
  processors,
  output,
  limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m", ...limits },
});

const codes = (document: unknown) => validatePipeline(document, { ...DEFAULT_VALIDATION_CONTEXT, testing: true }).errors.map((e) => `${e.code} ${e.path}`);

describe("split", () => {
  test("one message per element, parent metadata copied, ids in the parse_feed scheme", async () => {
    const { host } = await startHost();
    const doc = pipeline([{ list: [{ a: 1 }, { a: 2 }] }], [{ id: "each", type: "split", field: "/list" }, { id: "say", type: "template", target: "/out", text: "{{/a}}" }], { type: "host_result", title: "T", body: "/out" });
    doc.input = { type: "inject", messages: [{ data: { list: [{ a: 1 }, { a: 2 }] }, meta: { origin: "x" } }] } as any;
    const result = await host.call("pipeline.test", { pipeline: doc, llm: { mode: "echo" } });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["1", "2"]);
    expect(result.report.results.map((r: any) => r.idempotency_key.split("/").at(-1))).toEqual(["m1.0", "m1.1"]);
  }, 30_000);

  test("an empty array drops the message; a non-array is an error; extra items are a warning", async () => {
    const { host } = await startHost();
    const empty = await host.call("pipeline.test", { pipeline: pipeline([{ list: [] }], [{ id: "each", type: "split", field: "/list" }]) });
    expect(empty.status).toBe("succeeded");
    expect(empty.report.steps.find((s: any) => s.step_id === "each")).toMatchObject({ in: 1, out: 0 });
    const notArray = await host.call("pipeline.test", { pipeline: pipeline([{ list: "x" }], [{ id: "each", type: "split", field: "/list" }]) });
    expect(notArray.report.error).toMatchObject({ kind: "shape_mismatch", step_id: "each", message_id: "m1" });
    const many = await host.call("pipeline.test", { pipeline: pipeline([{ list: Array.from({ length: 1500 }, (_, i) => i) }], [{ id: "each", type: "split", field: "/list", max_items: 1000 }]) });
    expect(many.report.steps.find((s: any) => s.step_id === "each").out).toBe(1000);
    expect(many.report.warnings.map((w: any) => w.code)).toEqual(["split_truncated"]);
  }, 30_000);

  test("validation: the field must be an array where the shape is known; the item shape flows on", () => {
    const feed = {
      format: "wriven-workflow/pipeline@1",
      name: "S",
      input: { type: "host_trigger" },
      processors: [{ id: "each", type: "split", field: "/run_id" }],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
    };
    expect(codes(feed)).toEqual(["shape_mismatch /processors/0/field"]);
    const collected = { ...feed, processors: [{ id: "all", type: "collect" }, { id: "each", type: "split", field: "/items" }, { id: "t", type: "template", target: "/x", text: "{{/run_id}}" }] };
    expect(codes(collected)).toEqual([]);
    const wrong = { ...collected, processors: [...collected.processors.slice(0, 2), { id: "t", type: "template", target: "/x", text: "{{/count}}" }] };
    expect(codes(wrong)).toEqual(["unresolved_pointer /processors/2/text"]);
  });
});

describe("log", () => {
  test("lines go to the report and to pipeline.test; a missing value renders empty", async () => {
    const { host } = await startHost();
    const doc = pipeline([{ title: "A" }, {}], [{ id: "note", type: "log", text: "Kept {{/title}}." }]);
    const result = await host.call("pipeline.test", { pipeline: doc });
    expect(result.status).toBe("succeeded");
    expect(result.logs).toEqual([
      { step_id: "note", message_id: "m1", text: "Kept A." },
      { step_id: "note", message_id: "m2", text: "Kept ." },
    ]);
    expect(result.report.logs).toEqual(result.logs);
  }, 30_000);

  test("150 messages give 100 lines and one logs_truncated warning", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: pipeline(Array.from({ length: 150 }, (_, i) => ({ i })), [{ id: "note", type: "log", text: "{{/i}}" }]) });
    expect(result.logs.length).toBe(100);
    expect(result.report.warnings.map((w: any) => w.code)).toEqual(["logs_truncated"]);
  }, 30_000);

  test("logs_contain in an embedded test", async () => {
    const { host } = await startHost();
    const doc = {
      ...pipeline([{ title: "A" }], [{ id: "note", type: "log", text: "Kept {{/title}}" }]),
      tests: [
        { name: "found", expect: { status: "succeeded", logs_contain: ["Kept A"] } },
        { name: "absent", expect: { status: "succeeded", logs_contain: ["Kept B"] } },
      ],
    };
    const outcome = await host.call("pipeline.test", { pipeline: doc, run_embedded: true });
    expect(outcome.passed).toBe(1);
    expect(outcome.tests.find((t: any) => t.name === "absent").failures).toEqual(['no log line contains "Kept B"']);
  }, 30_000);
});

describe("sleep", () => {
  test("under pipeline.test it moves the clock instead of waiting", async () => {
    const { host } = await startHost();
    const doc = pipeline(
      [{ published: "2026-11-03T07:59:30Z" }],
      [
        { id: "wait", type: "sleep", duration: "1m" },
        { id: "fresh", type: "filter", keep_if: { field: "/published", newer_than: "1m" } },
      ],
      { type: "drop" },
      { run_timeout: "5m" },
    );
    const started = Date.now();
    const result = await host.call("pipeline.test", { pipeline: doc, clock: "2026-11-03T08:00:00Z" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe("succeeded");
    // 30 s old at the start, 90 s old after the minute the sleep moved the clock by.
    expect(result.report.steps.find((s: any) => s.step_id === "fresh")).toMatchObject({ in: 1, out: 0 });
    expect(result.report.steps.find((s: any) => s.step_id === "wait").duration_ms).toBeLessThan(1_000);
  }, 30_000);

  test("sleeps that add up to run_timeout fail validation", () => {
    const doc = pipeline([{}], [
      { id: "a", type: "sleep", duration: "3m" },
      { id: "b", type: "sleep", duration: "3m" },
    ], { type: "drop" }, { run_timeout: "5m" });
    expect(codes(doc)).toEqual(["sleep_exceeds_timeout /processors/1/duration"]);
    expect(codes(pipeline([{}], [{ id: "a", type: "sleep", duration: "6m" }]))).toEqual(["schema /processors/0/duration"]);
  });

  test("cancel interrupts a real sleep", async () => {
    const { host } = await startHost({ init: { sandbox: "optional" } });
    const doc = {
      format: "wriven-workflow/pipeline@1",
      name: "Nap",
      input: { type: "host_trigger" },
      processors: [{ id: "nap", type: "sleep", duration: "5m" }],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 0, runs_per_day: 4, run_timeout: "10m" },
    };
    const created = await host.call("stream.create", { pipeline: doc });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    await host.waitFor((m) => m.method === "run.started");
    await Bun.sleep(300);
    const cancelledAt = Date.now();
    await host.call("run.cancel", { run_id });
    const finished = await host.waitFor((m) => m.method === "run.finished", 7000);
    expect(finished.params.report.status).toBe("cancelled");
    expect(finished.params.report.cancelled_at_step).toBe("nap");
    expect(Date.now() - cancelledAt).toBeLessThan(1_500);
  }, 30_000);
});
