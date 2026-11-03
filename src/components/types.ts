// A component: its config schema, what it does to the shape of the data, and which permissions its
// config implies. Components are compiled in; agent mode has no module loading path.

import type { JsonSchema } from "../pipeline/json-schema.ts";
import type { PermissionsDraft } from "../pipeline/permissions.ts";
import type { Shape } from "../pipeline/shape.ts";
import type { StepList } from "../pipeline/tree.ts";

export type ComponentKind = "input" | "processor" | "output";

export interface PipelineIssue {
  path: string;
  code: string;
  message: string;
}

export interface CheckContext {
  // Path of this component's config in the pipeline document.
  path: string;
  clock: "host" | "engine";
  limits: { runs_per_day?: number; llm_calls_per_run?: number };
  error(code: string, field: string, message: string): void;
  warning(code: string, field: string, message: string): void;
  // Checks a field holding a pointer against the current shape; returns the shape found there.
  requirePointer(field: string, pointer: string, shape: Shape): Shape | null;
  requireString(field: string, pointer: string, shape: Shape): void;
  // Validates a nested step list (at `<path>/<field>/<i>`) from `shape`, returning the shape it emits.
  // `before` collects the shape each top-level step of the list receives.
  checkSteps(field: string, steps: any[], shape: Shape, before?: Shape[]): Shape;
}

// Walks sleeps along one path for `sleep_exceeds_timeout`. `elapsed` is the worst-case time before the
// step; `factor` multiplies each sleep (loops). Returns the worst-case time after it.
export type SleepWalk = (field: string, steps: any[], elapsed: number, factor: number) => number;

export interface ComponentDef {
  type: string;
  kind: ComponentKind;
  summary: string;
  // Fields of the config, without `type` and processor `id`.
  properties: JsonSchema;
  required?: string[];
  // The step lists a container holds. Leaves have none.
  children?(config: any): StepList[];
  // Ids a container names besides its steps' (workflow branches), unique pipeline-wide like step ids.
  extraIds?(config: any): Array<{ id: string; field: string }>;
  // Containers validate their lists through ctx.checkSteps and return the shape they emit; this
  // replaces `check` and `outputShape`.
  walk?(config: any, shape: Shape, ctx: CheckContext): Shape;
  // How a container's lists combine along one path for sleep time. Default: one after another.
  sleepWalk?(config: any, walk: SleepWalk, elapsed: number, factor: number): number;
  // Component-specific validation beyond the schema: URL rules, pointer resolution.
  check?(config: any, shape: Shape, ctx: CheckContext): void;
  // The data shape it emits, given the shape it receives. Omitted: unchanged.
  outputShape?(config: any, shape: Shape): Shape;
  // Every output message carries the id of an input message and none is made from nothing.
  preservesIds?: boolean;
  // What this component adds to the permissions object.
  permissions?(config: any, draft: PermissionsDraft): void;
}
