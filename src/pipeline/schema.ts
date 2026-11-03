// The published JSON Schema of the pipeline format, assembled from the component registry.

import { COMPONENTS, componentSchema } from "../components/definitions.ts";
import { PIPELINE_FORMAT } from "../version.ts";
import { COMPILED_CEILINGS } from "./ceilings.ts";
import { CONDITION_SCHEMA } from "./condition.ts";
import { DURATION_PATTERN } from "./duration.ts";
import type { JsonSchema } from "./json-schema.ts";

function ofKind(kind: string): JsonSchema {
  return { oneOf: COMPONENTS.filter((c) => c.kind === kind).map((c) => componentSchema(c, true)) };
}

export const LIMITS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["llm_calls_per_run", "runs_per_day", "run_timeout"],
  properties: {
    llm_calls_per_run: { type: "integer", minimum: 0, maximum: COMPILED_CEILINGS.llm_calls_per_run },
    runs_per_day: { type: "integer", minimum: 1, maximum: COMPILED_CEILINGS.runs_per_day },
    run_timeout: { type: "string", pattern: DURATION_PATTERN },
    llm_cost_per_run_usd: { type: "number", exclusiveMinimum: 0 },
  },
};

const TEST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "expect"],
  properties: {
    name: { type: "string", minLength: 1 },
    input: { type: "object" },
    llm: { type: "object" },
    fixtures: { type: "object" },
    network: { enum: ["mock", "live"] },
    clock: { type: "string" },
    state: { type: "object" },
    mocks: { type: "object" },
    expect: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["succeeded", "failed", "timed_out", "cancelled", "skipped"] },
        results_count: { type: "integer", minimum: 0 },
        result_body_contains: { type: "array", items: { type: "string" } },
        warnings_count: { type: "integer", minimum: 0 },
        error_kind: { type: "string" },
        logs_contain: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export const TOP_LEVEL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "name", "input", "processors", "output", "limits"],
  properties: {
    format: { const: PIPELINE_FORMAT },
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", maxLength: 500 },
    input: { type: "object" },
    processors: { type: "array", items: { type: "object" } },
    output: { type: "object" },
    limits: LIMITS_SCHEMA,
    schedule: {
      type: "object",
      additionalProperties: false,
      required: ["cron", "timezone"],
      properties: { cron: { type: "string" }, timezone: { type: "string" }, missed: { enum: ["skip", "run_once", "run_all"] } },
    },
    tests: { type: "array", items: TEST_SCHEMA },
  },
};

export function pipelineSchema(): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://wriven.dev/schemas/pipeline-1.json",
    title: "wriven-workflow pipeline, format 1",
    ...TOP_LEVEL_SCHEMA,
    properties: {
      ...TOP_LEVEL_SCHEMA.properties,
      input: ofKind("input"),
      processors: { type: "array", items: ofKind("processor") },
      output: ofKind("output"),
    },
    $defs: { condition: CONDITION_SCHEMA, processor: ofKind("processor") },
  };
}
