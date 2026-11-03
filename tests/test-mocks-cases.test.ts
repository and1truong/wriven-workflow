import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPO, startHost } from "./helpers.ts";

const FILTERED = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest-filter.json"), "utf8"));
const { tests: TESTS, ...PIPELINE } = FILTERED;
const WORKED = TESTS.find((t: any) => t.name === "one feed down, alpha posts summarised");
const URLS: string[] = PIPELINE.processors[0].urls;
const clone = <T>(value: T): T => structuredClone(value);

function mockErrors(mocks: unknown, pipeline: any = PIPELINE): string[] {
  const document = { ...pipeline, tests: [{ name: "t", mocks, expect: { status: "succeeded" } }] };
  return validatePipeline(document, { ...DEFAULT_VALIDATION_CONTEXT, testing: true }).errors.map((e) => `${e.code} ${e.path}`);
}

describe("mock cases at run time", () => {
  test("the worked example: one mocked failure skipped, entries picked by source_url, reply picked by prompt", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: PIPELINE, mocks: WORKED.mocks });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["The digest."]);
    expect(result.report.warnings).toEqual([{ step_id: "fetch", message_id: "m1.2", code: "http_status", message: "503", mocked: true }]);
    const steps = Object.fromEntries(result.report.steps.map((s: any) => [s.step_id, s]));
    expect(steps.fetch.mocked && steps.parse.mocked).toBe(true);
    expect(result.llm_requests[0].prompt).toContain("Alpha a1");
    expect(result.llm_requests[0].prompt).toContain("Alpha a2");
    expect(result.llm_requests[0].prompt).not.toContain("Beta b1");
    const embedded = await host.call("pipeline.test", { pipeline: FILTERED, run_embedded: true });
    expect(embedded.tests.map((t: any) => [t.name, t.failures])).toEqual(TESTS.map((t: any) => [t.name, []]));
  }, 30_000);

  test("no matching case is mock_unmatched, which on_error: skip does not skip", async () => {
    const { host } = await startHost();
    const gamma = clone(WORKED.mocks);
    gamma.summarize.cases[0].when.contains = "Gamma";
    const unmatched = await host.call("pipeline.test", { pipeline: PIPELINE, mocks: gamma });
    expect(unmatched.status).toBe("failed");
    expect(unmatched.report.error).toMatchObject({ kind: "mock_unmatched", step_id: "summarize" });
    expect(unmatched.report.error.message).toContain("summarize");
    const noBlog = clone(WORKED.mocks);
    noBlog.parse.cases.pop();
    const parse = await host.call("pipeline.test", { pipeline: PIPELINE, mocks: noBlog });
    expect(parse.report.error).toMatchObject({ kind: "mock_unmatched", step_id: "parse", message_id: "m1.1" });
  }, 30_000);

  test("without on_error: skip a mocked failure fails the run at the step", async () => {
    const { host } = await startHost();
    const strict = clone(PIPELINE);
    delete strict.processors[0].on_error;
    const result = await host.call("pipeline.test", { pipeline: strict, mocks: WORKED.mocks });
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "http_status", step_id: "fetch", message_id: "m1.2", mocked: true });
  }, 30_000);

  test("inside a try, catch gets the mocked failure's step, code and message", async () => {
    const { host } = await startHost();
    const pipeline = {
      format: "wriven-workflow/pipeline@1",
      name: "Notes",
      input: { type: "host_trigger" },
      processors: [
        {
          id: "sources",
          type: "try",
          steps: [{ id: "fetch", type: "http_fetch", urls: URLS }, { id: "parse", type: "parse_feed" }],
          catch: [{ id: "note", type: "template", target: "/title", text: "{{meta:error_step}} {{meta:error_code}} {{meta:error_message}}" }],
        },
        { id: "say", type: "template", target: "/out", text: "{{/title}}" },
      ],
      output: { type: "host_result", title: "T", body: "/out" },
      limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
    };
    const result = await host.call("pipeline.test", { pipeline, mocks: { fetch: WORKED.mocks.fetch, parse: WORKED.mocks.parse } });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body).at(-1)).toBe("fetch http_status 503");
    expect(result.report.warnings).toMatchObject([{ caught_by: "sources", mocked: true }]);
  }, 30_000);
});

describe("mock cases: validation", () => {
  test("the worked example is valid", () => {
    expect(mockErrors(WORKED.mocks)).toEqual([]);
  });

  test("case structure", () => {
    const cases = (list: unknown[]) => ({ fetch: { cases: list } });
    expect(mockErrors(cases([{ messages: [{ data: {} }] }, { when: { field: "/url", exists: true }, messages: [] }]))).toEqual(["invalid_mock /tests/0/mocks/fetch/cases/0"]);
    expect(mockErrors(cases([{ messages: [], fail: { code: "http_status" } }]))).toEqual(["invalid_mock /tests/0/mocks/fetch/cases/0"]);
    expect(mockErrors(cases(Array.from({ length: 21 }, () => ({ when: { field: "/url", exists: true }, messages: [] }))))).toEqual(["invalid_mock /tests/0/mocks/fetch/cases"]);
  });

  test("fail codes the component declares, and never on host_llm", () => {
    expect(mockErrors({ fetch: { fail: { code: "quota_exhausted" } } })).toEqual(["invalid_mock /tests/0/mocks/fetch"]);
    expect(mockErrors({ fetch: { fail: { code: "fetch_timeout" } } })).toEqual([]);
    expect(mockErrors({ summarize: { fail: { code: "http_status" } } })).toEqual(["invalid_mock /tests/0/mocks/summarize"]);
  });

  test("when is a condition on what the step sees", () => {
    // parse is mocked too, since a real parse_feed after an empty mocked page would miss /body.
    expect(mockErrors({ ...WORKED.mocks, fetch: { cases: [{ when: { field: "/title", equals: "x" }, messages: [{ data: {} }] }] } })).toEqual(["unresolved_pointer /tests/0/mocks/fetch/cases/0/when/field"]);
    expect(mockErrors({ ...WORKED.mocks, fetch: { cases: [{ when: { field: "/url", gt: 3 }, messages: [{ data: {} }] }] } })).toEqual(["shape_mismatch /tests/0/mocks/fetch/cases/0/when/field"]);
  });

  test("narrowing counts messages cases only", () => {
    const missing = clone(WORKED.mocks);
    delete missing.parse.cases[1].messages[0].data.id;
    expect(mockErrors(missing)).toEqual(["mock_missing_field /tests/0/mocks/parse"]);
    const withFail = clone(WORKED.mocks);
    withFail.parse.cases.splice(1, 0, { when: { field: "meta:source_url", equals: "https://nowhere.example/" }, fail: { code: "feed_invalid" } });
    expect(mockErrors(withFail)).toEqual([]);
  });

  test("components.list names each component's fail codes", async () => {
    const { host } = await startHost();
    const listed = await host.call("components.list");
    const codes = Object.fromEntries(listed.components.filter((c: any) => c.fail_codes).map((c: any) => [c.type, c.fail_codes]));
    expect(codes).toEqual({ http_fetch: ["http_status", "fetch_failed", "fetch_timeout", "body_too_large"], parse_feed: ["feed_invalid"] });
    expect(listed.mocks).toEqual({ cases: 20, messages: 500, replies: 100 });
  }, 30_000);
});
