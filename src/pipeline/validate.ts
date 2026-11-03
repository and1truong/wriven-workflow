// `pipeline.validate`: total validation with coded errors and paths. Never touches network or state.

import { COMPONENT_BY_TYPE, componentSchema } from "../components/definitions.ts";
import type { CheckContext, ComponentKind, PipelineIssue } from "../components/types.ts";
import { COMPILED_CEILINGS, type Ceilings } from "./ceilings.ts";
import { permissionsHash } from "./canonical.ts";
import { parseDuration } from "./duration.ts";
import { checkSchema, type SchemaError } from "./json-schema.ts";
import { derivePermissions, type Permissions } from "./permissions.ts";
import { DEFAULT_DISPLAY_NAME, renderPermissions, type RenderContext } from "./render.ts";
import { TOP_LEVEL_SCHEMA } from "./schema.ts";
import { describeShape, shapeAt, UNKNOWN, type Shape } from "./shape.ts";

export interface ValidationContext extends RenderContext {
  clock: "host" | "engine";
  capabilities: { llm: boolean; results: boolean };
  ceilings: Ceilings;
  // True inside `pipeline.test` and `tests[]`, where `inject` is allowed.
  testing?: boolean;
}

export const DEFAULT_VALIDATION_CONTEXT: ValidationContext = {
  clock: "engine",
  capabilities: { llm: true, results: true },
  ceilings: COMPILED_CEILINGS,
  displayName: DEFAULT_DISPLAY_NAME,
  sandboxAvailable: true,
  llmReportsCost: false,
};

export type ValidationResult =
  | { valid: false; errors: PipelineIssue[]; warnings: PipelineIssue[] }
  | { valid: true; errors: []; warnings: PipelineIssue[]; permissions: Permissions; permissions_hash: string; rendered: string[] };

function topLevelCode(error: SchemaError): string {
  if (error.path === "/limits" && error.keyword === "required") return "missing_limits";
  if (error.path === "/limits" || error.path.startsWith("/limits/")) {
    if (error.keyword === "required") return "missing_limits";
    if (error.keyword === "additionalProperties") return "unknown_field";
    return "limit_out_of_range";
  }
  return schemaCode(error);
}

function schemaCode(error: SchemaError): string {
  return error.keyword === "additionalProperties" ? "unknown_field" : "schema";
}

export function validatePipeline(document: unknown, ctx: ValidationContext): ValidationResult {
  const errors: PipelineIssue[] = [];
  const warnings: PipelineIssue[] = [];
  const failed = (): ValidationResult => ({ valid: false, errors, warnings });

  for (const error of checkSchema(TOP_LEVEL_SCHEMA, document)) {
    const missingLimits = error.path === "/limits" && error.keyword === "required";
    errors.push({ path: error.path, code: missingLimits ? "missing_limits" : topLevelCode(error), message: missingLimits ? "Every pipeline must have limits." : error.message });
  }
  if (errors.length > 0) return failed();
  const pipeline = document as any;

  checkComponent(pipeline.input, "input", "/input", errors);
  pipeline.processors.forEach((p: any, i: number) => checkComponent(p, "processor", `/processors/${i}`, errors));
  checkComponent(pipeline.output, "output", "/output", errors);
  const seen = new Set<string>();
  pipeline.processors.forEach((p: any, i: number) => {
    if (seen.has(p.id)) errors.push({ path: `/processors/${i}/id`, code: "schema", message: `The id ${p.id} is used twice.` });
    seen.add(p.id);
  });
  if (errors.length > 0) return failed();

  checkEnvironment(pipeline, ctx, errors);
  checkLimits(pipeline.limits, ctx.ceilings, errors);

  // Walk the pipeline in order, carrying the shape of the data.
  let shape: Shape = UNKNOWN;
  const steps: Array<[any, string]> = [
    [pipeline.input, "/input"],
    ...pipeline.processors.map((p: any, i: number) => [p, `/processors/${i}`] as [any, string]),
    [pipeline.output, "/output"],
  ];
  for (const [config, path] of steps) {
    const def = COMPONENT_BY_TYPE.get(config.type)!;
    def.check?.(config, shape, checkContext(path, pipeline, ctx, errors, warnings));
    shape = def.outputShape?.(config, shape) ?? shape;
  }
  if (errors.length > 0) return failed();

  checkTopLevelSchedule(pipeline, errors);
  if (errors.length > 0) return failed();

  const types: string[] = pipeline.processors.map((p: any) => p.type);
  const dedupeAt = types.lastIndexOf("dedupe");
  if (dedupeAt > types.indexOf("collect") && types.includes("collect")) {
    warnings.push({ path: `/processors/${dedupeAt}/type`, code: "dedupe_after_collect", message: "dedupe after collect sees one key per batch." });
  }

  const permissions = derivePermissions(pipeline);
  return {
    valid: true,
    errors: [],
    warnings,
    permissions,
    permissions_hash: permissionsHash(permissions),
    rendered: renderPermissions(permissions, ctx),
  };
}

function checkComponent(config: any, kind: ComponentKind, path: string, errors: PipelineIssue[]): void {
  const def = COMPONENT_BY_TYPE.get(config?.type);
  if (!def || def.kind !== kind) {
    const known = [...COMPONENT_BY_TYPE.values()].filter((c) => c.kind === kind).map((c) => c.type);
    errors.push({ path: `${path}/type`, code: "schema", message: `${JSON.stringify(config?.type)} is not ${kind === "input" ? "an" : "a"} ${kind} component; these exist: ${known.join(", ")}.` });
    return;
  }
  for (const error of checkSchema(componentSchema(def), config, path)) {
    errors.push({ path: error.path, code: schemaCode(error), message: error.message });
  }
}

// The top-level `schedule` only lets a host read the schedule without knowing components, so it must
// say the same as the input.
function checkTopLevelSchedule(pipeline: any, errors: PipelineIssue[]): void {
  if (pipeline.schedule === undefined) return;
  const { input, schedule } = pipeline;
  const same = input.type === "schedule" && schedule.cron === input.cron && schedule.timezone === input.timezone && (schedule.missed ?? "run_once") === (input.missed ?? "run_once");
  if (!same) errors.push({ path: "/schedule", code: "schema", message: "schedule must match the schedule input." });
}

function checkEnvironment(pipeline: any, ctx: ValidationContext, errors: PipelineIssue[]): void {
  if (pipeline.input.type === "inject" && !ctx.testing) {
    errors.push({ path: "/input/type", code: "input_not_allowed", message: "inject is only for tests; a stream needs host_trigger or schedule." });
  }
  const types = pipeline.processors.map((p: any) => p.type);
  if (types.includes("host_llm") && !ctx.capabilities.llm) {
    const index = types.indexOf("host_llm");
    errors.push({ path: `/processors/${index}/type`, code: "capability_missing", message: "This host does not serve model calls, so host_llm cannot be used." });
  }
  if (pipeline.output.type === "host_result" && !ctx.capabilities.results) {
    errors.push({ path: "/output/type", code: "capability_missing", message: "This host does not accept results, so host_result cannot be used." });
  }
}

function checkLimits(limits: any, ceilings: Ceilings, errors: PipelineIssue[]): void {
  const over = (field: string, value: unknown, ceiling: unknown) =>
    errors.push({ path: `/limits/${field}`, code: "limit_out_of_range", message: `${field} is ${value}; this engine allows at most ${ceiling}.` });
  if (limits.llm_calls_per_run > ceilings.llm_calls_per_run) over("llm_calls_per_run", limits.llm_calls_per_run, ceilings.llm_calls_per_run);
  if (limits.runs_per_day > ceilings.runs_per_day) over("runs_per_day", limits.runs_per_day, ceilings.runs_per_day);
  const timeout = parseDuration(limits.run_timeout);
  if (timeout < 30_000) {
    errors.push({ path: "/limits/run_timeout", code: "limit_out_of_range", message: `run_timeout is ${limits.run_timeout}; the minimum is 30s.` });
  } else if (timeout > parseDuration(ceilings.run_timeout)) {
    over("run_timeout", limits.run_timeout, ceilings.run_timeout);
  }
}

function checkContext(path: string, pipeline: any, ctx: ValidationContext, errors: PipelineIssue[], warnings: PipelineIssue[]): CheckContext {
  const requirePointer = (field: string, pointer: string, shape: Shape): Shape | null => {
    const found = shapeAt(shape, pointer);
    if (found.found) return found.shape;
    errors.push({ path: `${path}/${field}`, code: "unresolved_pointer", message: `${pointer} does not exist in the data at this step.` });
    return null;
  };
  return {
    path,
    clock: ctx.clock,
    limits: pipeline.limits,
    error: (code, field, message) => errors.push({ path: `${path}/${field}`, code, message }),
    warning: (code, field, message) => warnings.push({ path: `${path}/${field}`, code, message }),
    requirePointer,
    requireString(field, pointer, shape) {
      const found = requirePointer(field, pointer, shape);
      if (found && found.kind !== "string" && found.kind !== "unknown") {
        errors.push({ path: `${path}/${field}`, code: "shape_mismatch", message: `${pointer} is ${describeShape(found)} here; ${field} needs a string.` });
      }
    },
  };
}
