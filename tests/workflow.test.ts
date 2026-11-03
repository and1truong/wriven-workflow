import { describe, expect, test } from "bun:test";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { pipelineSchema } from "../src/pipeline/schema.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPORT_SCHEMA } from "../src/report.ts";
import { startHost, startInProcess } from "./helpers.ts";

const CTX = { ...DEFAULT_VALIDATION_CONTEXT, testing: true };
const ask = (id: string, text: string, target: string) => [
  { id: `${id}_prompt`, type: "template", target: "/p", text },
  { id, type: "host_llm", prompt: "/p", target },
];

const threeBranches = () => ({
  id: "enrich",
  type: "workflow",
  branches: [
    { id: "classify", steps: ask("classify_call", "Classify {{/run_id}}", "/category"), result: "/category", target: "/category" },
    { id: "translate", steps: ask("translate_call", "Translate {{/run_id}}", "/vi"), result: "/vi", target: "/translation" },
    { id: "headline", after: ["classify"], steps: ask("headline_call", "Headline for a {{/category}} item", "/headline"), result: "/headline", target: "/headline" },
  ],
});

const doc = (workflow: unknown, input: unknown = { type: "host_trigger" }, output: unknown = { type: "host_result", title: "H", body: "/headline" }) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Enrich",
  input,
  processors: [workflow],
  output,
  limits: { llm_calls_per_run: 10, runs_per_day: 4, run_timeout: "1m" },
});

const codes = (document: unknown) => validatePipeline(document, CTX).errors.map((e) => `${e.code} ${e.path}`);

describe("workflow at run time", () => {
  test("independent branches overlap calls; a branch after another sees its result", async () => {
    const { host } = await startInProcess({ llm: { latency_ms: 200 }, init: { sandbox: "optional", capabilities: { llm: true, results: true, llm_concurrency: 2 } } });
    const created = await host.call("stream.create", { pipeline: doc(threeBranches()) });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
    const report = finished.params.report;
    expect(report.status).toBe("succeeded");
    expect(host.peakLlm).toBe(2);
    const calls = host.received.filter((m) => m.method === "host.llm").map((m) => m.params);
    expect(calls.map((c) => c.step_id).slice(0, 2).sort()).toEqual(["classify_call", "translate_call"]);
    expect(calls[2].step_id).toBe("headline_call");
    expect(calls[2].messages[0].content).toBe(`Headline for a [echo] Classify ${run_id} item`);
    expect(host.results[0].result.body).toBe(`[echo] Headline for a [echo] Classify ${run_id} item`);
    expect(checkSchema(REPORT_SCHEMA, report)).toEqual([]);
    expect(report.steps.find((s: any) => s.step_id === "enrich").branches).toEqual({ classify: { skipped: 0 }, translate: { skipped: 0 }, headline: { skipped: 0 } });
  }, 30_000);

  test("from reads a sibling's target, so that branch waits for it; pipeline.test runs branches one at a time", async () => {
    const { host } = await startHost();
    const workflow = {
      id: "chain",
      type: "workflow",
      branches: [
        { id: "second", from: "/first", steps: [{ id: "s2", type: "template", target: "/x", text: "after {{/v}}" }], result: "/x", target: "/second" },
        { id: "first", steps: [{ id: "s1", type: "template", target: "/v", text: "one" }], target: "/first" },
      ],
    };
    const result = await host.call("pipeline.test", { pipeline: doc(workflow, { type: "inject", messages: [{ data: { q: 1 } }] }, { type: "host_result", title: "T", body: "/second" }) });
    expect(result.status).toBe("succeeded");
    expect(result.results[0].body).toBe("after one");
    expect(result.clamped).toEqual(["workflow:chain"]);
  }, 30_000);

  test("a filter that drops a message leaves its target unwritten, and a dependent skips it too", async () => {
    const { host } = await startHost();
    const workflow = {
      id: "pick",
      type: "workflow",
      branches: [
        { id: "only_news", steps: [{ id: "keep", type: "filter", keep_if: { field: "/kind", equals: "news" } }, { id: "mark", type: "template", target: "/m", text: "N{{/n}}" }], target: "/marked" },
        { id: "shout", from: "/marked", steps: [{ id: "loud", type: "template", target: "/x", text: "!" }], result: "/x", target: "/loud" },
      ],
    };
    const input = { type: "inject", messages: [{ data: { kind: "news", n: 1 } }, { data: { kind: "ad", n: 2 } }] };
    const result = await host.call("pipeline.test", { pipeline: doc(workflow, input, { type: "host_result", title: "T", body: "/kind" }) });
    expect(result.status).toBe("succeeded");
    expect(result.report.steps.find((s: any) => s.step_id === "pick").branches).toEqual({ only_news: { skipped: 1 }, shout: { skipped: 1 } });
    expect(result.report.steps.find((s: any) => s.step_id === "loud")).toMatchObject({ parent: "pick", in: 1 });
  }, 30_000);
});

describe("workflow validation", () => {
  test("the three-branch example validates and the published schema accepts it", () => {
    expect(codes(doc(threeBranches()))).toEqual([]);
    expect(checkSchema(pipelineSchema(), doc(threeBranches()))).toEqual([]);
  });

  test("after that closes a loop is a cycle", () => {
    const w = threeBranches();
    (w.branches[0] as any).after = ["headline"];
    expect(codes(doc(w))).toEqual(["cycle /processors/0/branches/0"]);
  });

  test("overlapping targets are a write_conflict", () => {
    const w = threeBranches();
    w.branches[1]!.target = "/category/fr";
    expect(codes(doc(w))).toContain("write_conflict /processors/0/branches/1/target");
  });

  test("reading a sibling's target without from or after is unresolved_pointer", () => {
    const w = threeBranches();
    delete (w.branches[2] as any).after;
    expect(codes(doc(w))).toEqual(["unresolved_pointer /processors/0/branches/2/steps/0/text"]);
  });

  test("branch steps must keep ids; branch ids are unique pipeline-wide; after names a sibling", () => {
    const w = threeBranches();
    w.branches[1]!.steps = [{ id: "explode", type: "split", field: "/run_id" } as any];
    expect(codes(doc(w))).toContain("changes_message_ids /processors/0/branches/1/steps/0/type");
    const dup = threeBranches();
    dup.branches[1]!.id = "classify_call";
    expect(codes(doc(dup)).map((c) => c.split(" ")[0])).toEqual(["duplicate_id"]);
    const stray = threeBranches();
    (stray.branches[2] as any).after = ["nowhere"];
    expect(codes(doc(stray))).toEqual(["schema /processors/0/branches/2/after/0"]);
  });

  test("target shapes come from the branch's steps", () => {
    const next = { id: "use", type: "host_llm", prompt: "/translation", target: "/out" };
    const document = { ...doc(threeBranches()), processors: [threeBranches(), next] };
    expect(codes(document)).toEqual([]);
    const wrong = { ...document, processors: [threeBranches(), { ...next, prompt: "/nothing" }] };
    expect(codes(wrong)).toEqual(["unresolved_pointer /processors/1/prompt"]);
  });
});
