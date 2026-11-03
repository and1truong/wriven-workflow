import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, permissionsHash } from "../src/pipeline/canonical.ts";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { derivePermissions } from "../src/pipeline/permissions.ts";
import { pipelineSchema } from "../src/pipeline/schema.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline, type ValidationContext } from "../src/pipeline/validate.ts";
import { effectiveCeilings } from "../src/pipeline/ceilings.ts";
import { REPO, startHost, spawnHost, initParams, stateDir } from "./helpers.ts";

const PIPELINES = join(REPO, "fixtures", "pipelines");
const read = (kind: string, file: string) => JSON.parse(readFileSync(join(PIPELINES, kind, file), "utf8"));
const WRIVEN: ValidationContext = { ...DEFAULT_VALIDATION_CONTEXT, clock: "host", displayName: "Wriven", sandboxAvailable: true };

// Codes a JSON Schema alone can see; the rest need the component walk.
const SCHEMA_LEVEL = new Set(["unknown_field", "missing_limits"]);

const basic = () => ({
  format: "wriven-workflow/pipeline@1",
  name: "Note",
  input: { type: "host_trigger" },
  processors: [{ id: "note", type: "template", target: "/note", text: "Run {{/run_id}}" }],
  output: { type: "host_result", title: "Note", body: "/note" },
  limits: { llm_calls_per_run: 0, runs_per_day: 2, run_timeout: "5m" },
});

describe("fixtures", () => {
  for (const file of readdirSync(join(PIPELINES, "valid"))) {
    test(`valid/${file} validates and the published schema accepts it`, () => {
      const document = read("valid", file);
      const result = validatePipeline(document, DEFAULT_VALIDATION_CONTEXT);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      const schema = pipelineSchema();
      expect(checkSchema(schema, document)).toEqual([]);
    });
  }
  for (const file of readdirSync(join(PIPELINES, "invalid"))) {
    const code = file.split("--")[0]!;
    test(`invalid/${file} fails with ${code}`, () => {
      const document = read("invalid", file);
      const result = validatePipeline(document, { ...DEFAULT_VALIDATION_CONTEXT, clock: file.includes("host-clock") ? "host" : "engine" });
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain(code);
      for (const error of result.errors) {
        expect(error.path).toStartWith("/");
        expect(error.message.length).toBeGreaterThan(0);
      }
      if (SCHEMA_LEVEL.has(code)) expect(checkSchema(pipelineSchema(), document).length).toBeGreaterThan(0);
    });
  }
});

describe("rendering", () => {
  test("host_trigger → template → host_result renders exactly", () => {
    const result = validatePipeline(basic(), WRIVEN);
    if (!result.valid) throw new Error("expected valid");
    expect(result.rendered).toEqual([
      "Runs: when Wriven asks.",
      "Fetches from: nowhere.",
      "Writes results to: Wriven.",
      "Limits: at most 2 runs per day; each run stops after 5 minutes.",
      "Does not: run programs, read or write your files, listen for connections, send data anywhere not listed above, or hold any API key.",
      "OS sandbox: on (macOS Seatbelt).",
    ]);
  });

  test("the last line says when the sandbox is unavailable", () => {
    const result = validatePipeline(basic(), { ...WRIVEN, sandboxAvailable: false });
    if (!result.valid) throw new Error("expected valid");
    expect(result.rendered.at(-1)).toBe("OS sandbox: unavailable on this Mac; only the engine's own checks apply.");
  });

  test("drop renders nowhere; the display name defaults to the host", () => {
    const result = validatePipeline({ ...basic(), processors: [], output: { type: "drop" } }, DEFAULT_VALIDATION_CONTEXT);
    if (!result.valid) throw new Error("expected valid");
    expect(result.rendered[0]).toBe("Runs: when the host asks.");
    expect(result.rendered[2]).toBe("Writes results to: nowhere.");
  });

  test("numbers get thousands separators without Intl", async () => {
    const { groupThousands } = await import("../src/pipeline/duration.ts");
    expect(groupThousands(10000)).toBe("10,000");
    expect(groupThousands(999)).toBe("999");
    expect(groupThousands(1234567)).toBe("1,234,567");
  });

  test("the same pipeline yields the same sentences and hash, byte for byte", () => {
    const a = validatePipeline(basic(), WRIVEN);
    const b = validatePipeline(basic(), WRIVEN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("hash", () => {
  test("unchanged under key reordering and whitespace", () => {
    const one = derivePermissions(basic());
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(basic()).reverse())));
    expect(permissionsHash(derivePermissions(reordered))).toBe(permissionsHash(one));
    expect(permissionsHash(derivePermissions(JSON.parse(JSON.stringify(basic(), null, 4))))).toBe(permissionsHash(one));
  });

  test("a zero-valued new field does not change it", () => {
    const permissions = derivePermissions(basic());
    expect(permissionsHash({ ...permissions, future_field: null, other: false, list: [] })).toBe(permissionsHash(permissions));
    expect(permissionsHash({ ...permissions, future_field: 1 })).not.toBe(permissionsHash(permissions));
  });

  test("the canonical form has sorted keys and no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: null })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("limits and ceilings", () => {
  test("host ceilings lower what validation accepts", () => {
    const ceilings = effectiveCeilings({ llm_calls_per_run: 10 });
    const document = { ...basic(), limits: { ...basic().limits, llm_calls_per_run: 11 } };
    const result = validatePipeline(document, { ...WRIVEN, ceilings });
    expect(result.errors.map((e) => e.code)).toEqual(["limit_out_of_range"]);
    expect(result.errors[0]!.message).toContain("10");
  });

  test("a ceiling above the compiled one at initialize is an error", async () => {
    const host = spawnHost();
    const response = await host.request("initialize", initParams(stateDir(), { ceilings: { llm_calls_per_run: 100 } }));
    expect(response.error.data.kind).toBe("invalid_params");
    expect(response.error.data.reason).toBe("ceiling_above_compiled");
  });

  test("initialize echoes the effective ceilings", async () => {
    const { init } = await startHost({ init: { ceilings: { llm_calls_per_run: 10, run_timeout: "10m" } } });
    expect(init.ceilings).toEqual({ llm_calls_per_run: 10, runs_per_day: 48, run_timeout: "10m", run_memory_mb: 512 });
  });
});

describe("over the protocol", () => {
  test("components.list returns the registry and the schema", async () => {
    const { host } = await startHost();
    const list = await host.call("components.list");
    expect(list.components.map((c: any) => c.type)).toEqual(expect.arrayContaining(["host_trigger", "template", "host_result", "inject", "drop"]));
    expect(list.pipeline_schema.properties.input.oneOf.length).toBe(list.components.filter((c: any) => c.kind === "input").length);
    const inputs = await host.call("components.list", { kind: "input" });
    expect(inputs.components.every((c: any) => c.kind === "input")).toBe(true);
  });

  test("pipeline.validate returns errors with paths and codes", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.validate", { pipeline: { ...basic(), extra: 1 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: "/extra", code: "unknown_field" });
  });

  test("a host without llm or results capability", async () => {
    const { host } = await startHost({ init: { capabilities: { llm: false, results: false } } });
    const result = await host.call("pipeline.validate", { pipeline: basic() });
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "/output/type", code: "capability_missing" }));
  });
});
