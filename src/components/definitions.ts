// The registry of components v0 knows about.

import { findPlaceholders } from "../pipeline/pointer.ts";
import { describeShape, mergeShapes, NUMBER, object, shapeAt, shapeWith, STRING, UNKNOWN, type Shape } from "../pipeline/shape.ts";
import { hostOfUrl, urlProblem } from "../pipeline/urls.ts";
import { POINTER_PATTERN } from "../pipeline/pointer.ts";
import { DURATION_PATTERN, groupThousands, parseDuration } from "../pipeline/duration.ts";
import { occurrencesPerDay, parseCron } from "../scheduler/cron.ts";
import { nextOccurrences } from "../scheduler/occurrences.ts";
import { isValidZone } from "../scheduler/zone.ts";
import { checkCondition } from "../pipeline/condition.ts";
import { containsType, preservesIds } from "../pipeline/tree.ts";
import { branchDependencies, branchOrder, pointersOverlap, transitiveDependencies } from "../pipeline/workflow.ts";
import type { ComponentDef } from "./types.ts";

const pointer = { type: "string", pattern: POINTER_PATTERN, patternMessage: "This must be a JSON Pointer such as /summary." };

// Stand-ins resolved by `componentSchema`: a plain object for the engine's own checks, which recurse
// with better messages, and a $ref into the pipeline schema's $defs when published.
const conditionRef = { "x-ref": "condition" };
const stepList = { type: "array", minItems: 1, items: { "x-ref": "processor" } };
const optionalSteps = { type: "array", items: { "x-ref": "processor" } };

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

const schedule: ComponentDef = {
  type: "schedule",
  kind: "input",
  summary: "Start a run at each occurrence of a cron expression, when the engine owns the clock.",
  properties: {
    cron: { type: "string" },
    timezone: { type: "string" },
    missed: { enum: ["skip", "run_once", "run_all"] },
  },
  required: ["cron", "timezone"],
  check(config, _shape, ctx) {
    if (ctx.clock !== "engine") {
      ctx.error("schedule_requires_engine_clock", "type", "This host keeps the clock, so a pipeline cannot have its own schedule; use host_trigger.");
    }
    let cron;
    try {
      cron = parseCron(config.cron);
    } catch (err) {
      ctx.error("schema", "cron", (err as Error).message);
    }
    if (!isValidZone(config.timezone)) {
      ctx.error("schema", "timezone", `${config.timezone} is not an IANA time zone name such as Australia/Brisbane.`);
    } else if (cron && nextOccurrences(cron, config.timezone, 0, 1).length === 0) {
      ctx.error("schema", "cron", `\`${config.cron}\` never fires.`);
    }
    if (cron && ctx.limits.runs_per_day !== undefined && occurrencesPerDay(cron) > ctx.limits.runs_per_day) {
      ctx.error("limit_out_of_range", "cron", `\`${config.cron}\` produces ${groupThousands(occurrencesPerDay(cron))} runs per day; runs_per_day is ${ctx.limits.runs_per_day}.`);
    }
  },
  outputShape: () => TRIGGER_SHAPE,
  permissions(config, draft) {
    draft.runs = { kind: "schedule", cron: config.cron, timezone: config.timezone, missed: config.missed ?? "run_once" };
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

const httpFetch: ComponentDef = {
  type: "http_fetch",
  kind: "processor",
  summary: "Fetch pages over HTTPS from listed hosts, one message per URL.",
  failCodes: ["http_status", "fetch_failed", "fetch_timeout", "body_too_large"],
  properties: {
    urls: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
    headers: {
      type: "object",
      additionalProperties: false,
      properties: { accept: { type: "string" }, "accept-language": { type: "string" }, "user-agent": { type: "string" } },
    },
    timeout: { type: "string", pattern: DURATION_PATTERN },
    max_bytes: { type: "integer", minimum: 1, maximum: 5 * 1024 * 1024 },
    on_error: { enum: ["fail", "skip"] },
    retry: retrySchema,
  },
  required: ["urls"],
  check(config, _shape, ctx) {
    (config.urls as string[]).forEach((url, i) => {
      const problem = urlProblem(url);
      if (problem) ctx.error("url_not_allowed", `urls/${i}`, problem);
    });
    if (config.timeout !== undefined && parseDuration(config.timeout) > 120_000) {
      ctx.error("schema", "timeout", "timeout may be at most 120s.");
    }
  },
  outputShape: () => object({ url: STRING, status: NUMBER, headers: UNKNOWN, body: STRING, content_type: STRING }),
  permissions(config, draft) {
    draft.fetched = true;
    for (const url of config.urls as string[]) {
      const host = hostOfUrl(url);
      if (!draft.network.some((n) => n.host === host)) draft.network.push({ host, scheme: "https", methods: ["GET"] });
    }
    if (config.retry) {
      draft.network_retry = { max_attempts: Math.max(draft.network_retry?.max_attempts ?? 0, config.retry.max_attempts) };
    }
    if (config.on_error === "skip") draft.skips_failed_sources = true;
  },
};

const parseFeed: ComponentDef = {
  type: "parse_feed",
  kind: "processor",
  summary: "Read /body as RSS or Atom and emit one message per entry, with HTML turned into plain text.",
  failCodes: ["feed_invalid"],
  properties: {
    max_entries: { type: "integer", minimum: 1, maximum: 500 },
    on_error: { enum: ["fail", "skip"] },
  },
  check(_config, shape, ctx) {
    ctx.requireString("type", "/body", shape);
  },
  outputShape: () =>
    object({ id: STRING, title: STRING, link: STRING, published: UNKNOWN, summary: STRING, content: STRING, author: STRING, feed: object({ title: STRING, url: STRING }) }),
  permissions(config, draft) {
    if (config.on_error === "skip") draft.skips_failed_sources = true;
  },
};

const filter: ComponentDef = {
  type: "filter",
  kind: "processor",
  summary: "Keep the messages for which keep_if is true and drop the rest. A condition on a missing field is false, so not of it is true.",
  properties: { keep_if: conditionRef },
  required: ["keep_if"],
  preservesIds: true,
  check(config, shape, ctx) {
    checkCondition(config.keep_if, "keep_if", shape, ctx);
  },
};

export const SPLIT_DEFAULT_MAX = 100;

const split: ComponentDef = {
  type: "split",
  kind: "processor",
  summary: "Turn the array at field into one message per element, with the parent's metadata. An empty array drops the message.",
  properties: {
    field: pointer,
    max_items: { type: "integer", minimum: 1, maximum: 1000 },
  },
  required: ["field"],
  check(config, shape, ctx) {
    const found = ctx.requirePointer("field", config.field, shape);
    if (found && found.kind !== "array" && found.kind !== "unknown") {
      ctx.error("shape_mismatch", "field", `${config.field} is ${describeShape(found)} here; split needs an array.`);
    }
  },
  outputShape(config, shape) {
    const found = shapeAt(shape, config.field);
    return found.found && found.shape.kind === "array" ? found.shape.items : UNKNOWN;
  },
};

const log: ComponentDef = {
  type: "log",
  kind: "processor",
  summary: "Append a line per message to the run report's logs, with {{/pointer}} and {{meta:key}} placeholders; a missing value renders empty.",
  properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["text"],
  preservesIds: true,
  check(config, _shape, ctx) {
    for (const raw of findPlaceholders(config.text).invalid) {
      ctx.error("schema", "text", `${raw} is not a placeholder; only {{/pointer}} and {{meta:key}} exist.`);
    }
  },
};

export const SLEEP_RANGE_MS = { minimum: 1_000, maximum: 300_000 };

const sleep: ComponentDef = {
  type: "sleep",
  kind: "processor",
  summary: "Wait once per batch, from 1s to 5m. Under pipeline.test it moves the test clock instead of waiting.",
  properties: { duration: { type: "string", pattern: DURATION_PATTERN } },
  required: ["duration"],
  preservesIds: true,
  check(config, _shape, ctx) {
    const ms = parseDuration(config.duration);
    if (ms < SLEEP_RANGE_MS.minimum || ms > SLEEP_RANGE_MS.maximum) ctx.error("schema", "duration", "duration must be from 1s to 5m.");
  },
};

const forEach: ComponentDef = {
  type: "for_each",
  kind: "processor",
  summary: "Run steps on each message as a batch of one, up to concurrency messages at a time; outputs keep input order. A collect inside sees one message.",
  properties: {
    steps: stepList,
    concurrency: { type: "integer", minimum: 1, maximum: 8 },
  },
  required: ["steps"],
  preservesIds: true,
  children: (config) => [{ field: "steps", steps: config.steps }],
  walk(config, shape, ctx) {
    (config.steps as any[]).forEach((step, i) => {
      if (step.type === "collect") ctx.warning("per_message_context", `steps/${i}/type`, "collect inside for_each sees one message at a time, so it collects one item.");
    });
    return ctx.checkSteps("steps", config.steps, shape);
  },
};

const switchDef: ComponentDef = {
  type: "switch",
  kind: "processor",
  summary:
    "Send each message to the first case whose when is true and run that case's steps on the messages it got. Unmatched messages go to default, or pass through unchanged when there is no default. Output keeps input order when every list keeps message ids; otherwise case by case, then default.",
  properties: {
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "object", additionalProperties: false, required: ["when", "steps"], properties: { when: conditionRef, steps: optionalSteps } },
    },
    default: optionalSteps,
  },
  required: ["cases"],
  preservesIds: true,
  children: (config) => [
    ...(Array.isArray(config.cases) ? config.cases : []).map((c: any, i: number) => ({ field: `cases/${i}/steps`, steps: c?.steps })),
    ...(config.default !== undefined ? [{ field: "default", steps: config.default }] : []),
  ],
  walk(config, shape, ctx) {
    let out: Shape | null = null;
    const join = (next: Shape) => {
      out = out === null ? next : mergeShapes(out, next);
    };
    (config.cases as any[]).forEach((c, i) => {
      checkCondition(c.when, `cases/${i}/when`, shape, ctx);
      join(ctx.checkSteps(`cases/${i}/steps`, c.steps, shape));
    });
    join(config.default !== undefined ? ctx.checkSteps("default", config.default, shape) : shape);
    return out!;
  },
};

const tryDef: ComponentDef = {
  type: "try",
  kind: "processor",
  summary:
    "Run steps; a unit that fails at one of them (one URL of http_fetch, one message elsewhere) leaves steps while the rest carry on. With catch steps, each failed unit goes through them as the failing step saw it, with meta error_step, error_code and error_message; their output follows the steps' output. catch: [] drops failed units and reports each; without catch a failure fails the run as if there were no try. Errors from the host, limits, timeouts and cancellation are never caught.",
  properties: { steps: stepList, catch: optionalSteps },
  required: ["steps"],
  preservesIds: true,
  children: (config) => [{ field: "steps", steps: config.steps }, ...(config.catch !== undefined ? [{ field: "catch", steps: config.catch }] : [])],
  walk(config, shape, ctx) {
    const before: Shape[] = [];
    const out = ctx.checkSteps("steps", config.steps, shape, before);
    if (!Array.isArray(config.catch) || config.catch.length === 0) return out;
    // catch gets a unit as its failing step saw it: the input of any step, or of a step nested in a
    // container, whose shape is not tracked here.
    const nested = (config.steps as any[]).some((s) => COMPONENT_BY_TYPE.get(s.type)?.children !== undefined);
    const unit = nested ? UNKNOWN : before.reduce((a, b) => mergeShapes(a, b));
    return mergeShapes(out, ctx.checkSteps("catch", config.catch, unit));
  },
  permissions(config, draft) {
    if (Array.isArray(config.catch) && config.catch.length === 0) draft.skips_failed_items = true;
    if (Array.isArray(config.catch) && config.catch.length > 0) draft.handles_failed_items = true;
  },
};

const whileDef: ComponentDef = {
  type: "while",
  kind: "processor",
  summary:
    "Repeat steps on each message while repeat_while is true for it, at most max_loops times (1-20, required). Checked before each pass, or after the first with at_least_once. steps must keep message ids. At the limit, on_limit fail (default) fails those messages with loop_limit; continue lets them leave with a warning.",
  properties: {
    repeat_while: conditionRef,
    steps: stepList,
    max_loops: { type: "integer", minimum: 1, maximum: 20 },
    at_least_once: { type: "boolean" },
    on_limit: { enum: ["fail", "continue"] },
  },
  required: ["repeat_while", "steps", "max_loops"],
  preservesIds: true,
  children: (config) => [{ field: "steps", steps: config.steps }],
  walk(config, shape, ctx) {
    (config.steps as any[]).forEach((step, i) => {
      if (!preservesIds(step)) ctx.error("changes_message_ids", `steps/${i}/type`, `${step.type} makes new message ids, so the loop could not tell which message is which; a while body must keep ids.`);
    });
    const out = ctx.checkSteps("steps", config.steps, shape);
    // Without at_least_once a message may leave before the first pass.
    const seen = config.at_least_once === true ? out : mergeShapes(shape, out);
    checkCondition(config.repeat_while, "repeat_while", seen, ctx);
    return seen;
  },
  sleepWalk: (config, walk, elapsed, factor) => walk("steps", config.steps, elapsed, factor * config.max_loops),
  permissions(config, draft) {
    // A fetch late in the body precedes the next pass's model call.
    if (containsType(config.steps, "http_fetch")) draft.fetched = true;
  },
};

const workflowDef: ComponentDef = {
  type: "workflow",
  kind: "processor",
  summary:
    "Run branches, each on a child of every message: the value at from (default: a copy of the whole message), through its steps, then the value at result (default: the root) written to target in the message. A branch waits for siblings whose target its from overlaps and for those in after; branches with no path between them run concurrently. A message whose from is missing, or whose child a step dropped, is skipped by that branch. Branch steps must keep message ids.",
  properties: {
    branches: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "steps", "target"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          from: pointer,
          steps: stepList,
          result: pointer,
          target: pointer,
          after: { type: "array", maxItems: 16, items: { type: "string" } },
        },
      },
    },
  },
  required: ["branches"],
  preservesIds: true,
  children: (config) => (Array.isArray(config.branches) ? config.branches : []).map((b: any, i: number) => ({ field: `branches/${i}/steps`, steps: b?.steps })),
  extraIds: (config) => (config.branches as any[]).map((b, i) => ({ id: b.id, field: `branches/${i}/id` })),
  walk(config, shape, ctx) {
    const branches = config.branches as any[];
    const index = new Map(branches.map((b, i) => [b.id, i]));
    branches.forEach((b, i) => {
      (b.after ?? []).forEach((name: string, j: number) => {
        if (!index.has(name) || name === b.id) ctx.error("schema", `branches/${i}/after/${j}`, `${name} is not another branch of this workflow.`);
      });
      (b.steps as any[]).forEach((step, k) => {
        if (!preservesIds(step)) ctx.error("changes_message_ids", `branches/${i}/steps/${k}/type`, `${step.type} makes new message ids, so its results could not be written back to their messages; branch steps must keep ids.`);
      });
      for (const other of branches.slice(0, i)) {
        if (pointersOverlap(b.target, other.target)) ctx.error("write_conflict", `branches/${i}/target`, `${b.target} overlaps ${other.target}, the target of branch ${other.id}.`);
      }
    });
    // Past a broken graph nothing downstream can be checked; unknown keeps errors to the cause.
    const deps = branchDependencies(branches.filter((b) => (b.after ?? []).every((a: string) => index.has(a))));
    if (deps.size !== branches.length) return UNKNOWN;
    const ordered = branchOrder(branches, deps);
    if ("cycle" in ordered) {
      ctx.error("cycle", `branches/${index.get(ordered.cycle[0]!)}`, `Branches ${ordered.cycle.join(", ")} wait for each other.`);
      return UNKNOWN;
    }
    const results = new Map<string, Shape>();
    let out = shape;
    for (const id of ordered.order) {
      const i = index.get(id)!;
      const b = branches[i];
      // A branch sees the message at the start plus what the branches it waits for wrote.
      const waited = transitiveDependencies(id, deps);
      let parent = shape;
      for (const dep of ordered.order) if (waited.has(dep)) parent = shapeWith(parent, branches[index.get(dep)!].target, results.get(dep)!) ?? parent;
      const child = b.from === undefined ? parent : (ctx.requirePointer(`branches/${i}/from`, b.from, parent) ?? UNKNOWN);
      const after = ctx.checkSteps(`branches/${i}/steps`, b.steps, child);
      const result = b.result === undefined ? after : (ctx.requirePointer(`branches/${i}/result`, b.result, after) ?? UNKNOWN);
      results.set(id, result);
      const written = shapeWith(out, b.target, result);
      if (written === null) ctx.error("unresolved_pointer", `branches/${i}/target`, `The parent of ${b.target} does not exist in the data at this step.`);
      else out = written;
    }
    return out;
  },
  permissions(config, draft) {
    // Branches may run in any order relative to each other.
    if ((config.branches as any[]).some((b) => containsType(b.steps, "http_fetch"))) draft.fetched = true;
  },
};

const DEFAULT_REMEMBER = "30d";
const DEFAULT_MAX_KEYS = 10_000;

const dedupe: ComponentDef = {
  type: "dedupe",
  kind: "processor",
  preservesIds: true,
  summary: "Drop messages whose key was seen in an earlier successful run of this stream.",
  properties: {
    key: pointer,
    remember: { type: "string", pattern: DURATION_PATTERN },
    max_keys: { type: "integer", minimum: 1, maximum: 100_000 },
  },
  required: ["key"],
  check(config, shape, ctx) {
    ctx.requirePointer("key", config.key, shape);
    if (config.remember !== undefined && parseDuration(config.remember) > parseDuration("365d")) {
      ctx.error("schema", "remember", "remember may be at most 365d.");
    }
  },
  permissions(config, draft) {
    const remember = config.remember ?? DEFAULT_REMEMBER;
    const maxKeys = config.max_keys ?? DEFAULT_MAX_KEYS;
    // Several dedupe steps state the widest: the sentence is what the person relies on.
    const longer = draft.state && parseDuration(draft.state.remember) > parseDuration(remember) ? draft.state.remember : remember;
    draft.state = { kind: "dedupe", remember: longer, max_keys: Math.max(draft.state?.max_keys ?? 0, maxKeys) };
  },
};

const collect: ComponentDef = {
  type: "collect",
  kind: "processor",
  summary: "Turn the current batch into one message: { items, count }.",
  properties: {
    min_items: { type: "integer", minimum: 0 },
    max_items: { type: "integer", minimum: 1, maximum: 1000 },
  },
  outputShape: (_config, shape) => object({ items: { kind: "array", items: shape }, count: NUMBER }),
};

const template: ComponentDef = {
  type: "template",
  kind: "processor",
  preservesIds: true,
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

const hostLlm: ComponentDef = {
  type: "host_llm",
  kind: "processor",
  preservesIds: true,
  summary: "Send a prompt to the host's language model and keep the reply.",
  properties: {
    prompt: pointer,
    target: pointer,
    system: { type: "string", maxLength: 4000 },
    max_output_tokens: { type: "integer", minimum: 1, maximum: 8192 },
  },
  required: ["prompt", "target"],
  check(config, shape, ctx) {
    ctx.requireString("prompt", config.prompt, shape);
    if (ctx.limits.llm_calls_per_run === 0) {
      ctx.error("limit_out_of_range", "type", "host_llm cannot run with llm_calls_per_run: 0.");
    }
    if (shapeWith(shape, config.target, STRING) === null) {
      ctx.error("unresolved_pointer", "target", `The parent of ${config.target} does not exist in the data at this step.`);
    }
  },
  outputShape: (config, shape) => shapeWith(shape, config.target, STRING) ?? shape,
  permissions(_config, draft) {
    draft.llm = {
      max_calls_per_run: draft.llmLimits.llm_calls_per_run,
      max_cost_per_run_usd: draft.llmLimits.llm_cost_per_run_usd ?? null,
      receives_fetched_content: (draft.llm?.receives_fetched_content ?? false) || draft.fetched,
    };
  },
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

export const DEDUPE_DEFAULTS = { remember: DEFAULT_REMEMBER, max_keys: DEFAULT_MAX_KEYS };

export const COMPONENTS: ComponentDef[] = [hostTrigger, schedule, inject, httpFetch, parseFeed, dedupe, collect, template, hostLlm, filter, split, log, sleep, forEach, switchDef, tryDef, whileDef, workflowDef, hostResult, drop];

export const COMPONENT_BY_TYPE = new Map(COMPONENTS.map((c) => [c.type, c]));

function resolveRefs(schema: unknown, published: boolean): unknown {
  if (Array.isArray(schema)) return schema.map((item) => resolveRefs(item, published));
  if (schema === null || typeof schema !== "object") return schema;
  const ref = (schema as Record<string, unknown>)["x-ref"];
  if (typeof ref === "string") return published ? { $ref: `#/$defs/${ref}` } : { type: "object" };
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, resolveRefs(value, published)]));
}

// `published` puts $refs into the pipeline schema's $defs where a component holds a condition or
// steps; the engine's own checks walk those itself.
export function componentSchema(def: ComponentDef, published = false): Record<string, any> {
  const isProcessor = def.kind === "processor";
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", ...(isProcessor ? ["id"] : []), ...(def.required ?? [])],
    properties: {
      type: { const: def.type },
      ...(isProcessor ? { id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" } } : {}),
      ...(resolveRefs(def.properties, published) as Record<string, any>),
    },
  };
}

export function publicComponents(): Array<{ type: string; kind: string; schema: Record<string, any>; summary: string; fail_codes?: string[] }> {
  return COMPONENTS.map((def) => ({ type: def.type, kind: def.kind, schema: componentSchema(def, true), summary: def.summary, ...(def.failCodes ? { fail_codes: def.failCodes } : {}) }));
}
