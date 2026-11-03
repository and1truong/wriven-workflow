// The declarative `condition` type: a boolean tree over field references with fixed operators. It
// cannot compute, loop or call (ADR 003). Spec: .agents/specs/composition.md#condition.

import type { Message } from "../executor/messages.ts";
import { StepError } from "../executor/messages.ts";
import { DURATION_PATTERN, parseDuration } from "./duration.ts";
import type { JsonSchema } from "./json-schema.ts";
import { isPointer, pointerGet } from "./pointer.ts";
import { describeShape, shapeAt, type Shape } from "./shape.ts";

export const CONDITION_LIMITS = { depth: 4, leaves: 32, values: 100 };

type ValueKind = "scalar" | "scalars" | "string" | "strings" | "number" | "boolean" | "duration";

// Operator → what its value is and which field kinds it reads.
const OPERATORS: Record<string, { value: ValueKind; fields: Array<Shape["kind"]> | "any"; caseless?: boolean }> = {
  equals: { value: "scalar", fields: ["string", "number", "boolean"] },
  in: { value: "scalars", fields: ["string", "number", "boolean"] },
  contains: { value: "scalar", fields: ["string", "array"], caseless: true },
  contains_any: { value: "strings", fields: ["string"], caseless: true },
  starts_with: { value: "string", fields: ["string"], caseless: true },
  exists: { value: "boolean", fields: "any" },
  gt: { value: "number", fields: ["number"] },
  gte: { value: "number", fields: ["number"] },
  lt: { value: "number", fields: ["number"] },
  lte: { value: "number", fields: ["number"] },
  newer_than: { value: "duration", fields: ["string"] },
  older_than: { value: "duration", fields: ["string"] },
};

export const OPERATOR_NAMES = Object.keys(OPERATORS);

const FIELD_PATTERN = "^((/([^~/]|~0|~1)*)+|meta:.+)$";

function valueSchema(kind: ValueKind): JsonSchema {
  const scalar = { type: ["string", "number", "boolean", "null"] };
  switch (kind) {
    case "scalar":
      return scalar;
    case "scalars":
      return { type: "array", minItems: 1, maxItems: CONDITION_LIMITS.values, items: scalar };
    case "string":
      return { type: "string" };
    case "strings":
      return { type: "array", minItems: 1, maxItems: CONDITION_LIMITS.values, items: { type: "string" } };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "duration":
      return { type: "string", pattern: DURATION_PATTERN };
  }
}

// The published schema, referenced as #/$defs/condition. Validation itself uses `checkCondition`,
// which gives an agent better messages than "matches no alternative".
export const CONDITION_SCHEMA: JsonSchema = {
  oneOf: [
    ...OPERATOR_NAMES.map((op) => ({
      type: "object",
      additionalProperties: false,
      required: ["field", op],
      properties: {
        field: { type: "string", pattern: FIELD_PATTERN },
        [op]: valueSchema(OPERATORS[op]!.value),
        ...(OPERATORS[op]!.caseless ? { case: { enum: ["insensitive"] } } : {}),
      },
    })),
    ...["all", "any"].map((name) => ({
      type: "object",
      additionalProperties: false,
      required: [name],
      properties: { [name]: { type: "array", minItems: 1, maxItems: CONDITION_LIMITS.leaves, items: { $ref: "#/$defs/condition" } } },
    })),
    { type: "object", additionalProperties: false, required: ["not"], properties: { not: { $ref: "#/$defs/condition" } } },
  ],
};

// What `components.list` tells an agent about conditions.
export const CONDITION_DOC = {
  leaf: '{ "field": "/pointer" or "meta:<key>", "<operator>": <value>, "case"?: "insensitive" }',
  operators: {
    equals: "the field equals a string, number, boolean or null",
    in: "the field equals one of a list of values",
    contains: "a string field contains the value as a substring, or an array field has an element equal to it",
    contains_any: "a string field contains any of a list of strings",
    starts_with: "a string field starts with the value",
    exists: "true: the field resolves; false: it does not",
    gt: "a number field is greater than the value",
    gte: "a number field is at least the value",
    lt: "a number field is less than the value",
    lte: "a number field is at most the value",
    newer_than: "an RFC 3339 time field is within a duration (24h, 7d) of the run's clock",
    older_than: "an RFC 3339 time field is more than a duration before the run's clock",
  },
  combinators: { all: "every condition in the list is true", any: "at least one is true", not: "the condition is false" },
  rules: [
    "A leaf on a missing field is false, except exists: false. So not of a leaf on a missing field is true.",
    "A null value counts as no value: only equals null and in with null can be true of it.",
    'case: "insensitive" applies to contains, contains_any and starts_with.',
    `At most ${CONDITION_LIMITS.depth} levels deep and ${CONDITION_LIMITS.leaves} leaves. There are no regular expressions.`,
  ],
};

export interface ConditionReport {
  error(code: string, field: string, message: string): void;
}

function valueMatches(kind: ValueKind, value: unknown): boolean {
  const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  switch (kind) {
    case "scalar":
      return isScalar(value);
    case "scalars":
      return Array.isArray(value) && value.length >= 1 && value.length <= CONDITION_LIMITS.values && value.every(isScalar);
    case "string":
      return typeof value === "string";
    case "strings":
      return Array.isArray(value) && value.length >= 1 && value.length <= CONDITION_LIMITS.values && value.every((v) => typeof v === "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "duration":
      return typeof value === "string" && new RegExp(DURATION_PATTERN).test(value);
  }
}

const VALUE_WORDS: Record<ValueKind, string> = {
  scalar: "a string, number, boolean or null",
  scalars: `a list of 1 to ${CONDITION_LIMITS.values} strings, numbers or booleans`,
  string: "a string",
  strings: `a list of 1 to ${CONDITION_LIMITS.values} strings`,
  number: "a number",
  boolean: "true or false",
  duration: "a duration such as 24h or 7d",
};

// Checks a condition's structure and, where the data shape is known, that each field can resolve and
// suits its operator. `field` is the path of the condition inside the component, such as `keep_if`.
export function checkCondition(condition: unknown, field: string, shape: Shape, report: ConditionReport): void {
  let leaves = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > CONDITION_LIMITS.depth) {
      report.error("schema", path, `A condition may nest at most ${CONDITION_LIMITS.depth} levels deep.`);
      return;
    }
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      report.error("schema", path, "A condition must be an object: a leaf such as { \"field\": \"/title\", \"contains\": \"rust\" }, or all, any or not.");
      return;
    }
    const keys = Object.keys(node);
    const object = node as Record<string, unknown>;
    if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
      const list = object[keys[0]];
      if (!Array.isArray(list) || list.length === 0) {
        report.error("schema", `${path}/${keys[0]}`, `${keys[0]} needs a list of at least one condition.`);
        return;
      }
      list.forEach((child, i) => walk(child, `${path}/${keys[0]}/${i}`, depth + 1));
      return;
    }
    if (keys.length === 1 && keys[0] === "not") {
      walk(object.not, `${path}/not`, depth + 1);
      return;
    }
    leaves++;
    if (leaves === CONDITION_LIMITS.leaves + 1) report.error("schema", path, `A condition may have at most ${CONDITION_LIMITS.leaves} leaves.`);
    checkLeaf(object, path, shape, report);
  };
  walk(condition, field, 1);
}

function checkLeaf(leaf: Record<string, unknown>, path: string, shape: Shape, report: ConditionReport): void {
  const ops = Object.keys(leaf).filter((k) => Object.hasOwn(OPERATORS, k));
  for (const key of Object.keys(leaf)) {
    if (key !== "field" && key !== "case" && !Object.hasOwn(OPERATORS, key)) {
      const hint = ["all", "any", "not"].includes(key) ? " all, any and not stand alone in their own object." : ` Operators: ${OPERATOR_NAMES.join(", ")}.`;
      report.error("unknown_field", `${path}/${key}`, `${key} is not a field of a condition.${hint}`);
    }
  }
  if (typeof leaf.field !== "string" || !new RegExp(FIELD_PATTERN).test(leaf.field)) {
    report.error("schema", `${path}/field`, "field must be a JSON Pointer such as /title, or meta:<key>.");
    return;
  }
  if (ops.length !== 1) {
    report.error("schema", path, ops.length === 0 ? `A condition needs one operator: ${OPERATOR_NAMES.join(", ")}.` : `A condition has exactly one operator; this one has ${ops.join(" and ")}. Combine them with all.`);
    return;
  }
  const op = ops[0]!;
  const spec = OPERATORS[op]!;
  if (!valueMatches(spec.value, leaf[op])) report.error("schema", `${path}/${op}`, `${op} needs ${VALUE_WORDS[spec.value]}.`);
  if (leaf.case !== undefined && (!spec.caseless || leaf.case !== "insensitive")) {
    report.error("schema", `${path}/case`, spec.caseless ? 'case may only be "insensitive".' : "case applies only to contains, contains_any and starts_with.");
  }
  const fieldShape = leaf.field.startsWith("meta:") ? ({ kind: "string" } as Shape) : lookup(shape, leaf.field);
  if (fieldShape === null) {
    if (op !== "exists") report.error("unresolved_pointer", `${path}/field`, `${leaf.field} does not exist in the data at this step.`);
    return;
  }
  if (spec.fields === "any" || fieldShape.kind === "unknown") return;
  if (!spec.fields.includes(fieldShape.kind)) {
    report.error("shape_mismatch", `${path}/field`, `${leaf.field} is ${describeShape(fieldShape)} here; ${op} needs ${spec.fields.map((k) => (k === "array" ? "an array" : `a ${k}`)).join(" or ")}.`);
    return;
  }
  // A scalar compared with a field of another kind can never be true.
  const value = leaf[op];
  const kindOf = (v: unknown) => (v === null ? null : typeof v);
  const clash = (v: unknown) => v !== null && fieldShape.kind !== "array" && kindOf(v) !== fieldShape.kind;
  if ((op === "equals" || (op === "contains" && fieldShape.kind === "string")) && clash(value)) {
    report.error("shape_mismatch", `${path}/${op}`, `${leaf.field} is ${describeShape(fieldShape)} here, so it never ${op === "equals" ? "equals" : "contains"} ${JSON.stringify(value)}.`);
  }
}

function lookup(shape: Shape, pointer: string): Shape | null {
  if (!isPointer(pointer)) return null;
  const found = shapeAt(shape, pointer);
  return found.found ? found.shape : null;
}

// Evaluates a valid condition against one message. `now` is the run's clock.
export function evaluate(condition: any, message: Message, now: Date): boolean {
  if (condition.all) return condition.all.every((c: any) => evaluate(c, message, now));
  if (condition.any) return condition.any.some((c: any) => evaluate(c, message, now));
  if (condition.not) return !evaluate(condition.not, message, now);
  const op = OPERATOR_NAMES.find((name) => Object.hasOwn(condition, name))!;
  const value = condition[op];
  const field: string = condition.field;
  const found = field.startsWith("meta:")
    ? Object.hasOwn(message.meta, field.slice(5))
      ? { found: true as const, value: message.meta[field.slice(5)] }
      : { found: false as const }
    : pointerGet(message.data, field);
  if (op === "exists") return found.found === value;
  if (!found.found) return false;
  const actual = found.value;
  // Null is "no value": only equals null can be true of it.
  if (actual === null) return op === "equals" ? value === null : op === "in" ? (value as unknown[]).includes(null) : false;
  const fold = (s: string) => (condition.case === "insensitive" ? s.toLowerCase() : s);
  const mismatch = (needs: string) => {
    throw new StepError("condition_type_mismatch", `${field} in message ${message.id} is ${describeValue(actual)}; ${op} needs ${needs}.`, { message_id: message.id });
  };
  switch (op) {
    case "equals":
      if (actual !== null && typeof actual === "object") mismatch("a string, number or boolean");
      return actual === value;
    case "in":
      if (typeof actual === "object") mismatch("a string, number or boolean");
      return (value as unknown[]).includes(actual);
    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => item === value || (typeof item === "string" && typeof value === "string" && fold(item) === fold(value)));
      if (typeof actual !== "string") return mismatch("a string or an array");
      return typeof value === "string" && fold(actual).includes(fold(value));
    case "contains_any":
      if (typeof actual !== "string") return mismatch("a string");
      return (value as string[]).some((v) => fold(actual).includes(fold(v)));
    case "starts_with":
      if (typeof actual !== "string") return mismatch("a string");
      return fold(actual).startsWith(fold(value));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number") return mismatch("a number");
      return op === "gt" ? actual > value : op === "gte" ? actual >= value : op === "lt" ? actual < value : actual <= value;
    }
    case "newer_than":
    case "older_than": {
      const at = typeof actual === "string" ? Date.parse(actual) : NaN;
      if (Number.isNaN(at)) return mismatch("an RFC 3339 time");
      const age = now.getTime() - at;
      return op === "newer_than" ? age <= parseDuration(value) : age > parseDuration(value);
    }
  }
  return false;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}
