import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSubset } from "../src/pipeline/subset.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPO, startHost } from "./helpers.ts";

const EXAMPLE = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest.json"), "utf8"));
const FIXTURES = EXAMPLE.tests[0].fixtures;
const URLS: string[] = EXAMPLE.processors[0].urls;
const DOWN = { ...FIXTURES, [URLS[2]!]: { status: 503, body: "down" } };

const sources = (extra: Record<string, unknown> = {}) => ({
  id: "sources",
  type: "try",
  steps: [
    { id: "fetch", type: "http_fetch", urls: URLS },
    { id: "parse", type: "parse_feed" },
  ],
  ...extra,
});

const digest = (first: unknown) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Digest",
  input: { type: "host_trigger" },
  processors: [first, { id: "say", type: "template", target: "/out", text: "{{/title}}" }],
  output: { type: "host_result", title: "Entry", body: "/out" },
  limits: { llm_calls_per_run: 0, runs_per_day: 2, run_timeout: "5m" },
});

describe("try with an empty catch", () => {
  test("one feed down: the others' entries arrive, one warning names the try", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: digest(sources({ catch: [] })), fixtures: DOWN });
    expect(result.status).toBe("succeeded");
    const titles = result.results.map((r: any) => r.body);
    expect(titles).toContain("Alpha a1");
    expect(titles).toContain("Beta b1");
    expect(titles).not.toContain("Gamma g1");
    expect(result.report.warnings).toEqual([
      { step_id: "fetch", message_id: "m1.2", code: "http_status", message: `${URLS[2]} returned 503`, caught_by: "sources" },
    ]);
  }, 30_000);

  test("permissions say an item that fails is skipped", () => {
    const result = validatePipeline(digest(sources({ catch: [] })), DEFAULT_VALIDATION_CONTEXT);
    if (!result.valid) throw new Error(JSON.stringify(result.errors));
    expect(result.permissions.skips_failed_items).toBe(true);
    expect(result.rendered).toContain("Skips an item that fails at a step, and says so in the run report.");
  });

  test("a message that fails inside a for_each is caught while the others carry on", async () => {
    const { host } = await startHost();
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Each",
      input: { type: "inject", messages: [{ data: { a: "1" } }, { data: {} }, { data: { a: "3" } }] },
      processors: [{ id: "guard", type: "try", catch: [], steps: [{ id: "each", type: "for_each", steps: [{ id: "say", type: "template", target: "/out", text: "{{/a}}" }] }] }],
      output: { type: "host_result", title: "T", body: "/out" },
      limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
    };
    const result = await host.call("pipeline.test", { pipeline });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["1", "3"]);
    expect(result.report.warnings).toMatchObject([{ step_id: "say", message_id: "m2", code: "unresolved_pointer", caught_by: "guard" }]);
  }, 30_000);
});

describe("try without catch", () => {
  test("only groups steps: a failure fails the run at the failing step", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: digest(sources()), fixtures: DOWN });
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "http_status", step_id: "fetch", message_id: "m1.2" });
    const result2 = validatePipeline(digest(sources()), DEFAULT_VALIDATION_CONTEXT);
    if (!result2.valid) throw new Error("expected valid");
    expect(result2.permissions.skips_failed_items).toBe(false);
  }, 30_000);

  test("inside an outer try with an empty catch, the outer one catches", async () => {
    const { host } = await startHost();
    const pipeline = digest({ id: "outer", type: "try", catch: [], steps: [sources()] });
    const result = await host.call("pipeline.test", { pipeline, fixtures: DOWN });
    expect(result.status).toBe("succeeded");
    expect(result.report.warnings.map((w: any) => w.caught_by)).toEqual(["outer"]);
  }, 30_000);
});

describe("what a try never catches", () => {
  test("quota_exhausted from the host at a host_llm inside a try fails the run", async () => {
    const { host } = await startHost({ llm: { error: { kind: "quota_exhausted", message: "No quota left." } }, init: { sandbox: "optional" } });
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Ask",
      input: { type: "host_trigger" },
      processors: [{ id: "guard", type: "try", catch: [], steps: [{ id: "p", type: "template", target: "/p", text: "hi" }, { id: "ask", type: "host_llm", prompt: "/p", target: "/a" }] }],
      output: { type: "drop" },
      limits: { llm_calls_per_run: 1, runs_per_day: 2, run_timeout: "1m" },
    };
    const created = await host.call("stream.create", { pipeline });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
    expect(finished.params.report.status).toBe("failed");
    expect(finished.params.report.error.kind).toBe("quota_exhausted");
    expect(finished.params.report.error.from_host).toBeUndefined();
    expect(finished.params.report.warnings).toEqual([]);
  }, 30_000);

  test("a missing fixture is not caught", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: digest(sources({ catch: [] })), fixtures: {} });
    expect(result.status).toBe("failed");
    expect(result.report.error.kind).toBe("fixture_missing");
  }, 30_000);
});

describe("on_error: skip is a try with an empty catch", () => {
  test("its warning has no caught_by and its sentence is unchanged", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: EXAMPLE, fixtures: DOWN, llm: { mode: "mock", responses: ["d"] } });
    expect(result.status).toBe("succeeded");
    expect(result.report.warnings).toEqual([{ step_id: "fetch", message_id: "m1.2", code: "http_status", message: `${URLS[2]} returned 503` }]);
  }, 30_000);

  test("skips_failed_items may go from true to false without approval, not back", () => {
    const skipping = validatePipeline(digest(sources({ catch: [] })), DEFAULT_VALIDATION_CONTEXT);
    const strict = validatePipeline(digest(sources()), DEFAULT_VALIDATION_CONTEXT);
    if (!skipping.valid || !strict.valid) throw new Error("expected valid");
    expect(isSubset(strict.permissions, skipping.permissions)).toBe(true);
    expect(isSubset(skipping.permissions, strict.permissions)).toBe(false);
  });
});
