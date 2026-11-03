// `pipeline.validate`: total validation with coded errors and paths. Never touches network or state.

import { COMPONENT_BY_TYPE, componentSchema } from "../components/definitions.ts";
import type { CheckContext, ComponentKind, PipelineIssue, SleepWalk } from "../components/types.ts";
import { COMPILED_CEILINGS, type Ceilings } from "./ceilings.ts";
import { permissionsHash } from "./canonical.ts";
import { parseDuration } from "./duration.ts";
import { checkSchema, type SchemaError } from "./json-schema.ts";
import { derivePermissions, type Permissions } from "./permissions.ts";
import { DEFAULT_DISPLAY_NAME, renderPermissions, type RenderContext } from "./render.ts";
import { TOP_LEVEL_SCHEMA } from "./schema.ts";
import { describeShape, shapeAt, UNKNOWN, type Shape } from "./shape.ts";
import { allSteps, childLists, STRUCTURE_LIMITS } from "./tree.ts";
import { checkMocks, type ShapeWalk } from "./mocks.ts";

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
  checkStepSchemas(pipeline.processors, "/processors", errors);
  checkComponent(pipeline.output, "output", "/output", errors);
  if (errors.length > 0) return failed();
  checkStructure(pipeline, errors);
  if (errors.length > 0) return failed();

  checkEnvironment(pipeline, ctx, errors);
  checkLimits(pipeline.limits, ctx.ceilings, errors);

  const shapeWalk = walker(pipeline, ctx);
  const walked = shapeWalk(new Map());
  errors.push(...walked.errors);
  warnings.push(...walked.warnings);
  if (errors.length > 0) return failed();

  checkTopLevelSchedule(pipeline, errors);
  checkSleeps(pipeline, errors);
  (pipeline.tests ?? []).forEach((test: any, i: number) => {
    if (test.mocks !== undefined) errors.push(...checkMocks(pipeline, test.mocks, `/tests/${i}/mocks`, shapeWalk));
  });
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

// Walks the pipeline in order, carrying the shape of the data; containers walk their own lists. A
// step in `overrides` is not checked and emits the shape given (a test mock). Returns what each
// processor step emitted, by id, with the issues found.
export function walker(pipeline: any, ctx: ValidationContext): ShapeWalk {
  return (overrides) => {
    const errors: PipelineIssue[] = [];
    const warnings: PipelineIssue[] = [];
    const outputs = new Map<string, Shape>();
    const walkList = (steps: any[], basePath: string, start: Shape, before?: Shape[]): Shape => {
      let shape = start;
      steps.forEach((config, i) => {
        before?.push(shape);
        shape = walkStep(config, `${basePath}/${i}`, shape);
      });
      return shape;
    };
    const walkStep = (config: any, path: string, shape: Shape): Shape => {
      const out = stepShape(config, path, shape);
      if (config.id !== undefined) outputs.set(config.id, out);
      return out;
    };
    const stepShape = (config: any, path: string, shape: Shape): Shape => {
      if (config.id !== undefined && overrides.has(config.id)) return overrides.get(config.id)!;
      const def = COMPONENT_BY_TYPE.get(config.type)!;
      const stepCtx = checkContext(path, pipeline, ctx, errors, warnings, walkList);
      if (def.walk) return def.walk(config, shape, stepCtx);
      def.check?.(config, shape, stepCtx);
      return def.outputShape?.(config, shape) ?? shape;
    };
    const shape = walkList(pipeline.processors, "/processors", walkStep(pipeline.input, "/input", UNKNOWN));
    walkStep(pipeline.output, "/output", shape);
    return { outputs, errors, warnings };
  };
}

// Returns whether the component's own schema passed, so a container's lists are only checked then.
function checkComponent(config: any, kind: ComponentKind, path: string, errors: PipelineIssue[]): boolean {
  const def = COMPONENT_BY_TYPE.get(config?.type);
  if (!def || def.kind !== kind) {
    const known = [...COMPONENT_BY_TYPE.values()].filter((c) => c.kind === kind).map((c) => c.type);
    errors.push({ path: `${path}/type`, code: "schema", message: `${JSON.stringify(config?.type)} is not ${kind === "input" ? "an" : "a"} ${kind} component; these exist: ${known.join(", ")}.` });
    return false;
  }
  const found = checkSchema(componentSchema(def), config, path);
  for (const error of found) errors.push({ path: error.path, code: schemaCode(error), message: error.message });
  return found.length === 0;
}

function checkStepSchemas(steps: any[], basePath: string, errors: PipelineIssue[]): void {
  steps.forEach((config, i) => {
    const path = `${basePath}/${i}`;
    if (!checkComponent(config, "processor", path, errors)) return;
    for (const list of childLists(config)) checkStepSchemas(list.steps, `${path}/${list.field}`, errors);
  });
}

// Ids unique across the whole tree, nesting depth and step count within the compiled-in limits.
function checkStructure(pipeline: any, errors: PipelineIssue[]): void {
  const steps = allSteps(pipeline);
  const seen = new Set<string>();
  for (const step of steps) {
    const named = [{ id: step.config.id, field: "id" }, ...(COMPONENT_BY_TYPE.get(step.config.type)?.extraIds?.(step.config) ?? [])];
    for (const { id, field } of named) {
      if (seen.has(id)) errors.push({ path: `${step.path}/${field}`, code: "duplicate_id", message: `The id ${id} is used twice; ids are unique across the whole pipeline, nested steps and workflow branches included.` });
      seen.add(id);
    }
    if (step.depth === STRUCTURE_LIMITS.nesting_depth + 1) {
      errors.push({ path: step.path, code: "nesting_too_deep", message: `This step is inside ${step.depth} containers; at most ${STRUCTURE_LIMITS.nesting_depth} may nest.` });
    }
  }
  if (steps.length > STRUCTURE_LIMITS.steps) {
    errors.push({ path: "/processors", code: "too_many_steps", message: `The pipeline has ${steps.length} steps, nested ones included; at most ${STRUCTURE_LIMITS.steps} are allowed.` });
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
  const llm = allSteps(pipeline).find((s) => s.config.type === "host_llm");
  if (llm && !ctx.capabilities.llm) {
    errors.push({ path: `${llm.path}/type`, code: "capability_missing", message: "This host does not serve model calls, so host_llm cannot be used." });
  }
  if (pipeline.output.type === "host_result" && !ctx.capabilities.results) {
    errors.push({ path: "/output/type", code: "capability_missing", message: "This host does not accept results, so host_result cannot be used." });
  }
}

// Sleeps along one path must leave the run time to finish: a pipeline that cannot is invalid, not slow.
function checkSleeps(pipeline: any, errors: PipelineIssue[]): void {
  const timeout = parseDuration(pipeline.limits.run_timeout);
  const walk = (steps: any[], basePath: string, start: number, factor: number): number => {
    let elapsed = start;
    steps.forEach((config, i) => {
      const path = `${basePath}/${i}`;
      if (config.type === "sleep") {
        const next = elapsed + parseDuration(config.duration) * factor;
        if (next >= timeout && elapsed < timeout) {
          errors.push({ path: `${path}/duration`, code: "sleep_exceeds_timeout", message: `Sleeps along this path can add up to ${Math.round(next / 1000)}s, which is not below run_timeout ${pipeline.limits.run_timeout}.` });
        }
        elapsed = next;
        return;
      }
      const def = COMPONENT_BY_TYPE.get(config.type)!;
      const inner: SleepWalk = (field, list, e, f) => walk(list, `${path}/${field}`, e, f);
      if (def.sleepWalk) elapsed = def.sleepWalk(config, inner, elapsed, factor);
      else for (const list of childLists(config)) elapsed = inner(list.field, list.steps, elapsed, factor);
    });
    return elapsed;
  };
  walk(pipeline.processors, "/processors", 0, 1);
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

function checkContext(
  path: string,
  pipeline: any,
  ctx: ValidationContext,
  errors: PipelineIssue[],
  warnings: PipelineIssue[],
  walkList: (steps: any[], basePath: string, shape: Shape, before?: Shape[]) => Shape,
): CheckContext {
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
    checkSteps: (field, steps, shape, before) => walkList(steps, `${path}/${field}`, shape, before),
    requireString(field, pointer, shape) {
      const found = requirePointer(field, pointer, shape);
      if (found && found.kind !== "string" && found.kind !== "unknown") {
        errors.push({ path: `${path}/${field}`, code: "shape_mismatch", message: `${pointer} is ${describeShape(found)} here; ${field} needs a string.` });
      }
    },
  };
}
