// The registry of components v0 knows about.

import { findPlaceholders } from "../pipeline/pointer.ts";
import { object, shapeWith, STRING, UNKNOWN } from "../pipeline/shape.ts";
import { POINTER_PATTERN } from "../pipeline/pointer.ts";
import { DURATION_PATTERN } from "../pipeline/duration.ts";
import type { ComponentDef } from "./types.ts";

const pointer = { type: "string", pattern: POINTER_PATTERN, patternMessage: "This must be a JSON Pointer such as /summary." };

export const retrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["max_attempts"],
  properties: {
    max_attempts: { type: "integer", minimum: 2, maximum: 3 },
    backoff: { type: "string", pattern: DURATION_PATTERN },
  },
};

export const TRIGGER_SHAPE = object({ trigger: STRING, scheduled_for: UNKNOWN, run_id: STRING });

const hostTrigger: ComponentDef = {
  type: "host_trigger",
  kind: "input",
  summary: "Start a run when the host asks.",
  properties: {},
  outputShape: () => TRIGGER_SHAPE,
  permissions: (_config, draft) => {
    draft.runs = { kind: "host" };
  },
};

const inject: ComponentDef = {
  type: "inject",
  kind: "input",
  summary: "Test only: emit the given messages as one batch.",
  properties: {
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: {}, meta: { type: "object", additionalProperties: { type: "string" } } },
      },
    },
  },
  required: ["messages"],
  outputShape: () => UNKNOWN,
  permissions: (_config, draft) => {
    draft.runs = { kind: "host" };
  },
};

const template: ComponentDef = {
  type: "template",
  kind: "processor",
  summary: "Build text from a template with {{/pointer}} and {{meta:key}} placeholders.",
  properties: {
    text: { type: "string", maxLength: 20_000 },
    target: pointer,
    missing: { enum: ["error", "empty"] },
  },
  required: ["text", "target"],
  check(config, shape, ctx) {
    const { placeholders, invalid } = findPlaceholders(config.text);
    for (const raw of invalid) {
      ctx.error("schema", "text", `${raw} is not a placeholder; only {{/pointer}} and {{meta:key}} exist.`);
    }
    if (config.missing !== "empty") {
      for (const placeholder of placeholders) {
        if (placeholder.pointer) ctx.requirePointer("text", placeholder.pointer, shape);
      }
    }
    if (shapeWith(shape, config.target, STRING) === null) {
      ctx.error("unresolved_pointer", "target", `The parent of ${config.target} does not exist in the data at this step.`);
    }
  },
  outputShape: (config, shape) => shapeWith(shape, config.target, STRING) ?? shape,
};

const hostResult: ComponentDef = {
  type: "host_result",
  kind: "output",
  summary: "Send one result per message to the host.",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    body: pointer,
    format: { enum: ["markdown", "text"] },
    retry: retrySchema,
  },
  required: ["title", "body"],
  check(config, shape, ctx) {
    ctx.requireString("body", config.body, shape);
  },
  permissions(config, draft) {
    draft.results = { kind: "host", retry: config.retry ? { max_attempts: config.retry.max_attempts } : null };
  },
};

const drop: ComponentDef = {
  type: "drop",
  kind: "output",
  summary: "Acknowledge and discard.",
  properties: {},
  permissions(_config, draft) {
    draft.results = { kind: "none", retry: null };
  },
};

export const COMPONENTS: ComponentDef[] = [hostTrigger, inject, template, hostResult, drop];

export const COMPONENT_BY_TYPE = new Map(COMPONENTS.map((c) => [c.type, c]));

export function componentSchema(def: ComponentDef): Record<string, any> {
  const isProcessor = def.kind === "processor";
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", ...(isProcessor ? ["id"] : []), ...(def.required ?? [])],
    properties: {
      type: { const: def.type },
      ...(isProcessor ? { id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" } } : {}),
      ...def.properties,
    },
  };
}

export function publicComponents(): Array<{ type: string; kind: string; schema: Record<string, any>; summary: string }> {
  return COMPONENTS.map((def) => ({ type: def.type, kind: def.kind, schema: componentSchema(def), summary: def.summary }));
}
