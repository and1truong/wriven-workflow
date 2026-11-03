import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/pipeline/condition.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPO, startHost } from "./helpers.ts";

const NOW = new Date("2026-11-03T08:00:00Z");
const message = (data: unknown, meta: Record<string, string> = {}) => ({ id: "m1", data, meta });
const holds = (condition: unknown, data: unknown, meta?: Record<string, string>) => evaluate(condition, message(data, meta), NOW);

const inject = (messages: unknown[], processors: unknown[]) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Filter",
  input: { type: "inject", messages: messages.map((data) => ({ data })) },
  processors,
  output: { type: "drop" },
  limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
});

const afterFeed = (keep_if: unknown) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Condition",
  input: { type: "host_trigger" },
  processors: [
    { id: "fetch", type: "http_fetch", urls: ["https://example.com/feed.xml"] },
    { id: "parse", type: "parse_feed" },
    { id: "keep", type: "filter", keep_if },
  ],
  output: { type: "drop" },
  limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
});

const errorsOf = (keep_if: unknown) => {
  const result = validatePipeline(afterFeed(keep_if), DEFAULT_VALIDATION_CONTEXT);
  return result.errors.map((e) => `${e.code} ${e.path}`);
};

describe("evaluate", () => {
  test("equals and in", () => {
    expect(holds({ field: "/n", equals: 3 }, { n: 3 })).toBe(true);
    expect(holds({ field: "/n", equals: 3 }, { n: 4 })).toBe(false);
    expect(holds({ field: "/s", in: ["a", "b"] }, { s: "b" })).toBe(true);
    expect(holds({ field: "/s", in: ["a", "b"] }, { s: "c" })).toBe(false);
  });

  test("contains on strings and arrays, with and without case", () => {
    expect(holds({ field: "/t", contains: "rust" }, { t: "Rust 2.0" })).toBe(false);
    expect(holds({ field: "/t", contains: "rust", case: "insensitive" }, { t: "Rust 2.0" })).toBe(true);
    expect(holds({ field: "/tags", contains: "news" }, { tags: ["tech", "news"] })).toBe(true);
    expect(holds({ field: "/tags", contains: 3 }, { tags: [1, 2] })).toBe(false);
  });

  test("contains_any and starts_with", () => {
    expect(holds({ field: "/t", contains_any: ["zig", "rust"], case: "insensitive" }, { t: "Why Zig" })).toBe(true);
    expect(holds({ field: "/t", contains_any: ["zig", "rust"] }, { t: "Go news" })).toBe(false);
    expect(holds({ field: "/t", starts_with: "re:", case: "insensitive" }, { t: "RE: hello" })).toBe(true);
    expect(holds({ field: "/t", starts_with: "re:" }, { t: "hello re:" })).toBe(false);
  });

  test("comparisons", () => {
    expect(holds({ field: "/n", gt: 3 }, { n: 4 })).toBe(true);
    expect(holds({ field: "/n", gt: 3 }, { n: 3 })).toBe(false);
    expect(holds({ field: "/n", gte: 3 }, { n: 3 })).toBe(true);
    expect(holds({ field: "/n", lt: 3 }, { n: 2 })).toBe(true);
    expect(holds({ field: "/n", lte: 3 }, { n: 4 })).toBe(false);
  });

  test("newer_than and older_than use the run's clock", () => {
    expect(holds({ field: "/p", newer_than: "24h" }, { p: "2026-11-02T09:00:00Z" })).toBe(true);
    expect(holds({ field: "/p", newer_than: "24h" }, { p: "2026-11-01T09:00:00Z" })).toBe(false);
    expect(holds({ field: "/p", older_than: "7d" }, { p: "2026-10-01T00:00:00Z" })).toBe(true);
  });

  test("exists, missing fields and not", () => {
    expect(holds({ field: "/t", exists: true }, { t: "x" })).toBe(true);
    expect(holds({ field: "/t", exists: false }, {})).toBe(true);
    expect(holds({ field: "/t", contains: "ad" }, {})).toBe(false);
    expect(holds({ not: { field: "/t", contains: "ad" } }, {})).toBe(true);
  });

  test("null is no value", () => {
    expect(holds({ field: "/p", newer_than: "24h" }, { p: null })).toBe(false);
    expect(holds({ field: "/p", equals: null }, { p: null })).toBe(true);
    expect(holds({ field: "/p", exists: true }, { p: null })).toBe(true);
  });

  test("metadata keys", () => {
    expect(holds({ field: "meta:source_url", starts_with: "https://a." }, {}, { source_url: "https://a.example/feed" })).toBe(true);
    expect(holds({ field: "meta:missing", exists: false }, {})).toBe(true);
  });

  test("all and any", () => {
    const both = { all: [{ field: "/a", equals: 1 }, { field: "/b", equals: 2 }] };
    expect(holds(both, { a: 1, b: 2 })).toBe(true);
    expect(holds(both, { a: 1, b: 3 })).toBe(false);
    expect(holds({ any: [{ field: "/a", equals: 9 }, { field: "/b", equals: 2 }] }, { a: 1, b: 2 })).toBe(true);
  });

  test("a type that does not suit the operator is condition_type_mismatch", () => {
    expect(() => holds({ field: "/n", gt: 3 }, { n: "four" })).toThrow(expect.objectContaining({ kind: "condition_type_mismatch" }));
    expect(() => holds({ field: "/p", newer_than: "1d" }, { p: "yesterday" })).toThrow(expect.objectContaining({ kind: "condition_type_mismatch" }));
  });
});

describe("checking conditions", () => {
  test("gt on a string field after parse_feed is shape_mismatch at the condition's path", () => {
    expect(errorsOf({ field: "/title", gt: 3 })).toEqual(["shape_mismatch /processors/2/keep_if/field"]);
  });

  test("a field that cannot resolve is unresolved_pointer, except under exists", () => {
    expect(errorsOf({ field: "/rating", equals: 5 })).toEqual(["unresolved_pointer /processors/2/keep_if/field"]);
    expect(errorsOf({ field: "/rating", exists: false })).toEqual([]);
  });

  test("nested paths, unknown operators and two operators", () => {
    expect(errorsOf({ all: [{ field: "/title", contains: "a" }, { not: { field: "/title", gt: 1 } }] })).toEqual(["shape_mismatch /processors/2/keep_if/all/1/not/field"]);
    expect(errorsOf({ field: "/title", matches: "^a" })).toContain("unknown_field /processors/2/keep_if/matches");
    expect(errorsOf({ field: "/title", contains: "a", starts_with: "b" })).toEqual(["schema /processors/2/keep_if"]);
  });

  test("values, case and comparisons that can never hold", () => {
    expect(errorsOf({ field: "/title", contains_any: [] })).toEqual(["schema /processors/2/keep_if/contains_any"]);
    expect(errorsOf({ field: "/title", gt: 1, case: "insensitive" })).toContain("schema /processors/2/keep_if/case");
    expect(errorsOf({ field: "/title", equals: 3 })).toEqual(["shape_mismatch /processors/2/keep_if/equals"]);
    expect(errorsOf({ field: "/published", newer_than: "soon" })).toEqual(["schema /processors/2/keep_if/newer_than"]);
  });

  test("at most four levels and 32 leaves", () => {
    const leaf = { field: "/title", contains: "a" };
    expect(errorsOf({ not: { not: { not: leaf } } })).toEqual([]);
    expect(errorsOf({ not: { not: { not: { not: leaf } } } })).toEqual(["schema /processors/2/keep_if/not/not/not/not"]);
    expect(errorsOf({ any: Array.from({ length: 32 }, () => leaf) })).toEqual([]);
    expect(errorsOf({ any: Array.from({ length: 33 }, () => leaf) })).toEqual(["schema /processors/2/keep_if/any/32"]);
  });

  test("filter adds no permission", () => {
    const example = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest.json"), "utf8"));
    const filtered = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest-filter.json"), "utf8"));
    const a = validatePipeline(example, DEFAULT_VALIDATION_CONTEXT);
    const b = validatePipeline(filtered, DEFAULT_VALIDATION_CONTEXT);
    if (!a.valid || !b.valid) throw new Error("expected valid");
    expect(b.permissions_hash).toBe(a.permissions_hash);
  });
});

describe("filter at run time", () => {
  test("keeps the matching message and reports the dropped ones", async () => {
    const { host } = await startHost();
    const pipeline = inject(
      [{ title: "Rust 2.0" }, { title: "Go news" }, { summary: "no title" }],
      [{ id: "keep", type: "filter", keep_if: { field: "/title", contains_any: ["rust"], case: "insensitive" } }, { id: "say", type: "template", target: "/out", text: "{{/title}}" }],
    );
    pipeline.output = { type: "host_result", title: "T", body: "/out" } as any;
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["Rust 2.0"]);
    expect(result.report.steps.find((s: any) => s.step_id === "keep")).toMatchObject({ in: 3, out: 1, dropped: 2 });
  }, 30_000);

  test("a type mismatch at run time fails the run naming the step and message", async () => {
    const { host } = await startHost();
    const pipeline = inject([{ n: 1 }, { n: "two" }], [{ id: "big", type: "filter", keep_if: { field: "/n", gt: 0 } }]);
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "condition_type_mismatch", step_id: "big", message_id: "m2" });
  }, 30_000);

  test("the feed example with a keyword filter runs green and sends only matching entries", async () => {
    const { host } = await startHost();
    const { tests, ...pipeline } = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest-filter.json"), "utf8"));
    const result = await host.call("pipeline.test", { pipeline, fixtures: tests[0].fixtures, llm: { mode: "mock", responses: ["Digest."] } });
    expect(result.status).toBe("succeeded");
    expect(result.llm_requests[0].prompt).toContain("Alpha a1");
    expect(result.llm_requests[0].prompt).not.toContain("Beta b1");
    const embedded = await host.call("pipeline.test", { pipeline: { ...pipeline, tests }, run_embedded: true });
    expect(embedded.status).toBe("passed");
  }, 30_000);
});
