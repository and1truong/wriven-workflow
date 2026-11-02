// A component: its config schema, what it does to the shape of the data, and which permissions its
// config implies. Components are compiled in; agent mode has no module loading path.

import type { JsonSchema } from "../pipeline/json-schema.ts";
import type { PermissionsDraft } from "../pipeline/permissions.ts";
import type { Shape } from "../pipeline/shape.ts";

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
}

export interface ComponentDef {
  type: string;
  kind: ComponentKind;
  summary: string;
  // Fields of the config, without `type` and processor `id`.
  properties: JsonSchema;
  required?: string[];
  // Component-specific validation beyond the schema: URL rules, pointer resolution.
  check?(config: any, shape: Shape, ctx: CheckContext): void;
  // The data shape it emits, given the shape it receives. Omitted: unchanged.
  outputShape?(config: any, shape: Shape): Shape;
  // What this component adds to the permissions object.
  permissions?(config: any, draft: PermissionsDraft): void;
}
