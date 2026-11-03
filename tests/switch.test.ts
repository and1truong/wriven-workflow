import { describe, expect, test } from "bun:test";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { pipelineSchema } from "../src/pipeline/schema.ts";
import { mergeShapes, NUMBER, object, STRING, UNKNOWN } from "../src/pipeline/shape.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { startHost } from "./helpers.ts";

const KINDS = ["news", "tutorial", "news", "other", "tutorial"];

const doc = (route: Record<string, unknown>, output = "/label") => ({
  format: "wriven-workflow/pipeline@1",
  name: "Route",
  input: { type: "inject", messages: KINDS.map((kind, i) => ({ data: { kind, n: i + 1 } })) },
  processors: [{ id: "route", type: "switch", ...route }],
  output: { type: "host_result", title: "R", body: output },
  limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
});

const label = (id: string, text: string) => ({ id, type: "template", target: "/label", text });
const isKind = (kind: string) => ({ field: "/kind", equals: kind });

describe("shape merging", () => {
  test("objects merge key by key; one-sided keys and differing kinds become unknown", () => {
    expect(mergeShapes(object({ a: STRING, b: STRING }), object({ a: STRING, c: NUMBER }))).toEqual(object({ a: STRING, b: UNKNOWN, c: UNKNOWN }));
    expect(mergeShapes(STRING, NUMBER)).toEqual(UNKNOWN);
    expect(mergeShapes({ kind: "array", items: object({ x: STRING }) }, { kind: "array", items: object({ x: STRING }) })).toEqual({ kind: "array", items: object({ x: STRING }) });
  });
});

describe("switch at run time", () => {
  test("id-preserving cases keep input order, each message with its case's write", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", {
      pipeline: doc({
        cases: [
          { when: isKind("news"), steps: [label("news_label", "N{{/n}}")] },
          { when: isKind("tutorial"), steps: [label("tut_label", "T{{/n}}")] },
        ],
        default: [label("other_label", "O{{/n}}")],
      }),
    });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(["N1", "T2", "N3", "O4", "T5"]);
  }, 30_000);

  test("a collect in case 1 comes first, then case 2's messages, then unmatched", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", {
      pipeline: doc(
        {
          cases: [
            { when: isKind("news"), steps: [{ id: "gather", type: "collect" }, { id: "count", type: "template", target: "/label", text: "news x{{/count}}" }] },
            { when: isKind("tutorial"), steps: [label("tut_label", "T{{/n}}")] },
          ],
        },
        "/label",
      ),
    });
    // Message 4 matched nothing and has no /label: it passes through and fails at the output.
    expect(result.status).toBe("failed");
    expect(result.report.error).toMatchObject({ kind: "unresolved_pointer", message_id: "m4", step_id: "output" });
    expect(result.results.map((r: any) => r.body)).toEqual(["news x2", "T2", "T5"]);
  }, 30_000);

  test("unmatched without default passes through unchanged; an empty case passes its messages through", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", {
      pipeline: doc({ cases: [{ when: isKind("news"), steps: [] }, { when: isKind("tutorial"), steps: [label("tut_label", "T{{/n}}")] }] }, "/kind"),
    });
    expect(result.status).toBe("succeeded");
    expect(result.results.map((r: any) => r.body)).toEqual(KINDS);
    expect(result.report.steps.find((s: any) => s.step_id === "tut_label")).toMatchObject({ parent: "route", invocations: 1, in: 2 });
  }, 30_000);
});

describe("switch validation", () => {
  const trigger = (route: Record<string, unknown>, next: unknown[]) => ({
    format: "wriven-workflow/pipeline@1",
    name: "R",
    input: { type: "host_trigger" },
    processors: [{ id: "route", type: "switch", ...route }, ...next],
    output: { type: "drop" },
    limits: { llm_calls_per_run: 0, runs_per_day: 1, run_timeout: "1m" },
  });
  const codes = (document: unknown) => validatePipeline(document, DEFAULT_VALIDATION_CONTEXT).errors.map((e) => `${e.code} ${e.path}`);

  test("a field written by only one case is checked at run time; a field both write validates statically", () => {
    const route = {
      cases: [
        { when: { field: "/trigger", equals: "host" }, steps: [{ id: "a", type: "template", target: "/both", text: "x" }, { id: "b", type: "template", target: "/only_a", text: "x" }] },
        { when: { field: "/trigger", equals: "schedule" }, steps: [{ id: "c", type: "template", target: "/both", text: "y" }] },
      ],
      default: [{ id: "d", type: "template", target: "/both", text: "z" }],
    };
    expect(codes(trigger(route, [{ id: "use", type: "template", target: "/out", text: "{{/both}} {{/only_a}}" }]))).toEqual([]);
    // /both is a string on every path, so host_llm accepts it; only the zero call limit is wrong.
    expect(codes(trigger(route, [{ id: "use", type: "host_llm", prompt: "/both", target: "/out" }]))).toEqual(["limit_out_of_range /processors/1/type"]);
    expect(codes(trigger(route, [{ id: "use", type: "template", target: "/out", text: "{{/nowhere}}" }]))).toEqual(["unresolved_pointer /processors/1/text"]);
  });

  test("conditions and nested steps are checked with their paths; the published schema accepts a switch", () => {
    expect(codes(trigger({ cases: [{ when: { field: "/trigger", gt: 1 }, steps: [] }] }, []))).toEqual(["shape_mismatch /processors/0/cases/0/when/field"]);
    expect(codes(trigger({ cases: [{ when: { field: "/trigger", equals: "host" }, steps: [{ id: "x", type: "template", target: "/a" }] }] }, []))).toEqual(["schema /processors/0/cases/0/steps/0/text"]);
    expect(codes(trigger({ cases: [] }, []))).toEqual(["schema /processors/0/cases"]);
    const document = doc({ cases: [{ when: isKind("news"), steps: [label("n", "x")] }], default: [] });
    expect(checkSchema(pipelineSchema(), document)).toEqual([]);
  });
});
