// Test mocks: in `pipeline.test` and `tests[]`, a processor step replaced by fixed output, keyed by
// step id, chosen per unit by `cases`. Checked here against what the real step declares; the run
// process picks cases and emits `messages` or fails (`runMock` in runtime.ts), and the harness
// answers `replies` for host_llm from the case the run process picked.

import { COMPONENT_BY_TYPE } from "../components/definitions.ts";
import type { PipelineIssue } from "../components/types.ts";
import { checkCondition } from "./condition.ts";
import { NUMBER, object, STRING, UNKNOWN, type Shape } from "./shape.ts";
import { allSteps, ancestorsOf, preservesIds } from "./tree.ts";

// Compiled in and reported by `components.list`. 500 is parse_feed's own max_entries.
export const MOCK_LIMITS = { cases: 20, messages: 500, replies: 100 };

export interface MockMessage {
  data: unknown;
  meta?: Record<string, string>;
}

export interface MockCase {
  when?: unknown;
  messages?: MockMessage[];
  replies?: string[];
  fail?: { code: string; message?: string };
}

// As written: one outcome as shorthand for a single case without `when`, or `cases`.
export interface Mock extends MockCase {
  cases?: MockCase[];
}

// Walks the pipeline's shapes. A step in `overrides` is not checked and emits the shape given.
// Returns the shape each processor step received and emitted, by id, and the issues found.
export type ShapeWalk = (overrides: Map<string, Shape>) => {
  inputs: Map<string, Shape>;
  outputs: Map<string, Shape>;
  errors: PipelineIssue[];
  warnings: PipelineIssue[];
};

const OUTCOMES = ["messages", "replies", "fail"] as const;

const escapeToken = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The cases of a mock that passed `checkMocks`.
export function mockCases(mock: Mock): MockCase[] {
  return mock.cases ?? [mock];
}

// Issues with `mocks` at `basePath` (`/mocks` or `/tests/<i>/mocks`). `walk` runs over a pipeline
// that is already valid.
export function checkMocks(pipeline: any, mocks: unknown, basePath: string, walk: ShapeWalk): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  if (!isObject(mocks)) return [{ path: basePath, code: "invalid_mock", message: "mocks is an object from processor step id to a mock." }];
  const steps = new Map(allSteps(pipeline).map((s) => [s.config.id as string, s]));
  const base = walk(new Map());
  // Per mock: its messages, each with the path its data is reported under.
  const narrowing = new Map<string, { path: string; messages: Array<{ path: string; message: MockMessage }> }>();
  for (const [id, mock] of Object.entries(mocks)) {
    const path = `${basePath}/${escapeToken(id)}`;
    const step = steps.get(id);
    if (!step) {
      issues.push({ path, code: "unknown_step", message: `There is no processor step with id ${id}; mocks replace processor steps by id.` });
      continue;
    }
    const problem = structureProblem(step.config, mock);
    if (problem) {
      issues.push({ path: problem.at ? `${path}/${problem.at}` : path, code: "invalid_mock", message: problem.message });
      continue;
    }
    const mocked = ancestorsOf(pipeline, id).find((a) => Object.hasOwn(mocks, a.id));
    if (mocked) {
      issues.push({ path, code: "mock_unreachable", message: `${id} is inside ${mocked.id}, which is mocked, so ${id} never runs.` });
      continue;
    }
    const cases = (mock as Mock).cases;
    const located = (cases ?? [mock as MockCase]).map((c, i) => ({ c, at: cases ? `${path}/cases/${i}` : path }));
    for (const { c, at } of located) {
      if (c.when !== undefined) checkCondition(c.when, `${at}/when`, whenShape(step.config, base.inputs.get(id) ?? UNKNOWN), { error: (code, field, message) => issues.push({ path: field, code, message }) });
    }
    const messages = located.flatMap(({ c, at }) => (c.messages ?? []).map((message, j) => ({ path: `${at}/messages/${j}`, message })));
    const crowded = located.find(({ c }) => (c.messages?.length ?? 0) > 1);
    if (preservesIds(step.config) && crowded) {
      issues.push({ path: `${crowded.at}/messages`, code: "changes_message_ids", message: `${step.config.type} keeps message ids, so its mock emits at most one message for each message it receives.` });
      continue;
    }
    if (step.config.type === "http_fetch" && messages.some(({ message }) => message.meta && Object.hasOwn(message.meta, "source_url"))) {
      issues.push({ path, code: "mock_shape_mismatch", message: "A mocked http_fetch sets meta source_url to each URL itself." });
      continue;
    }
    if (located.some(({ c }) => c.messages !== undefined)) narrowing.set(id, { path, messages });
  }
  if (narrowing.size === 0) return issues;

  // What each mock emits: the declared shape, cut down to the fields every one of its messages carries.
  // fail cases emit nothing and do not count.
  const { outputs } = base;
  const narrowed = new Map<string, Shape>();
  for (const [id, { messages }] of narrowing) {
    const declared = outputs.get(id) ?? UNKNOWN;
    const before = issues.length;
    const shapes = messages.map(({ path, message }) => restrict(message.data, declared, `${path}/data`, "", steps.get(id)!.config.type, issues));
    if (issues.length > before) continue;
    narrowed.set(id, shapes.length === 0 ? declared : shapes.reduce(intersect));
  }

  // One walk per mock, the others emitting their declared shape, so each missing field is the fault
  // of exactly one mock.
  for (const [id, shape] of narrowed) {
    const overrides = new Map<string, Shape>();
    // Every structurally sound mock replaces its step, even one whose messages had issues of their own.
    for (const other of narrowing.keys()) overrides.set(other, other === id ? shape : (outputs.get(other) ?? UNKNOWN));
    for (const error of walk(overrides).errors) {
      const reader = readerAt(pipeline, error.path);
      issues.push({ path: narrowing.get(id)!.path, code: "mock_missing_field", message: `${reader} (at ${error.path}) needs what the mock of ${id} leaves out: ${error.message}` });
    }
  }
  return issues;
}

// What a case's `when` evaluates against, per unit of the step.
function whenShape(config: any, input: Shape): Shape {
  if (config.type === "http_fetch") return object({ url: STRING });
  if (config.type === "host_llm") return object({ prompt: STRING, system: STRING });
  if (config.type === "collect") return object({ items: { kind: "array", items: input }, count: NUMBER });
  return input;
}

function structureProblem(config: any, mock: unknown): { message: string; at?: string } | null {
  if (!isObject(mock)) return { message: "A mock is an object with messages, replies, fail or cases." };
  if (Object.hasOwn(mock, "cases")) {
    const extra = Object.keys(mock).find((k) => k !== "cases");
    if (extra !== undefined) return { message: `${extra} cannot stand beside cases; put it in a case.` };
    const cases = mock.cases;
    if (!Array.isArray(cases) || cases.length === 0) return { message: "cases is a list of at least one case." };
    if (cases.length > MOCK_LIMITS.cases) return { message: `A mock has at most ${MOCK_LIMITS.cases} cases.`, at: "cases" };
    for (const [i, c] of cases.entries()) {
      const problem = caseProblem(config, c, true);
      if (problem) return { message: problem, at: `cases/${i}` };
      if ((c as MockCase).when === undefined && i < cases.length - 1) return { message: "A case without when matches everything, so it must be the last.", at: `cases/${i}` };
    }
    return null;
  }
  const problem = caseProblem(config, mock, false);
  return problem ? { message: problem } : null;
}

function caseProblem(config: any, mock: unknown, inCases: boolean): string | null {
  if (!isObject(mock)) return "A case is an object with when and one of messages, replies or fail.";
  const allowed = inCases ? ["when", ...OUTCOMES] : [...OUTCOMES];
  const unknown = Object.keys(mock).find((k) => !allowed.includes(k));
  if (unknown !== undefined) return `${unknown} is not a field of a ${inCases ? "case" : "mock"}; it has ${allowed.join(", ")}${inCases ? "" : ", or cases"}.`;
  const outcomes = OUTCOMES.filter((k) => Object.hasOwn(mock, k));
  if (outcomes.length !== 1) return `A ${inCases ? "case" : "mock"} has exactly one of messages, replies or fail${outcomes.length > 1 ? `, not ${outcomes.join(" and ")}` : ""}.`;
  if (config.type === "host_llm" && outcomes[0] !== "replies") return "host_llm is mocked with replies, so its prompt is still rendered, recorded and counted against llm_calls_per_run.";
  if (mock.replies !== undefined) {
    if (config.type !== "host_llm") return `replies answers host_llm; ${config.id} is ${config.type}, so mock it with messages.`;
    const replies = mock.replies;
    if (!Array.isArray(replies) || replies.length === 0 || replies.some((r) => typeof r !== "string")) return "replies is a list of strings, at least one.";
    if (replies.length > MOCK_LIMITS.replies) return `A case has at most ${MOCK_LIMITS.replies} replies.`;
    return null;
  }
  if (mock.fail !== undefined) {
    const fail = mock.fail;
    const codes = COMPONENT_BY_TYPE.get(config.type)?.failCodes ?? [];
    if (!isObject(fail) || typeof fail.code !== "string" || Object.keys(fail).some((k) => k !== "code" && k !== "message") || (fail.message !== undefined && typeof fail.message !== "string")) {
      return "fail is { code, message? }.";
    }
    if (!codes.includes(fail.code)) {
      return codes.length === 0
        ? `${config.type} has no failure a try can catch, so it cannot be mocked with fail.`
        : `${config.type} can fail with ${codes.join(", ")}, not ${fail.code}.`;
    }
    return null;
  }
  const messages = mock.messages;
  if (!Array.isArray(messages)) return "messages is a list of { data, meta? }.";
  if (messages.length > MOCK_LIMITS.messages) return `A case has at most ${MOCK_LIMITS.messages} messages.`;
  for (const [j, m] of messages.entries()) {
    if (!isObject(m) || !Object.hasOwn(m, "data") || Object.keys(m).some((k) => k !== "data" && k !== "meta")) return `messages/${j} is { data, meta? }.`;
    if (m.meta !== undefined && (!isObject(m.meta) || Object.values(m.meta).some((v) => typeof v !== "string"))) return `messages/${j}/meta maps keys to strings.`;
  }
  return null;
}

// The shape of `value` as far as `declared` describes it; anything it does not describe is an issue.
function restrict(value: unknown, declared: Shape, base: string, pointer: string, type: string, issues: PipelineIssue[]): Shape {
  const mismatch = (message: string): Shape => {
    issues.push({ path: `${base}${pointer}`, code: "mock_shape_mismatch", message });
    return declared;
  };
  const at = pointer === "" ? "The data" : pointer;
  switch (declared.kind) {
    case "unknown":
      return UNKNOWN;
    case "string":
    case "number":
    case "boolean":
      // Shapes have no nullability, and real components emit null (parse_feed's published).
      if (value === null || typeof value === declared.kind) return declared;
      return mismatch(`${at} is ${describeValue(value)}; ${type} emits a ${declared.kind} there.`);
    case "array": {
      if (!Array.isArray(value)) return mismatch(`${at} is ${describeValue(value)}; ${type} emits an array there.`);
      const items = value.map((item, i) => restrict(item, declared.items, base, `${pointer}/${i}`, type, issues));
      return { kind: "array", items: items.length === 0 ? declared.items : items.reduce(intersect) };
    }
    case "object": {
      if (!isObject(value)) return mismatch(`${at} is ${describeValue(value)}; ${type} emits an object there.`);
      const props: Record<string, Shape> = {};
      for (const [key, inner] of Object.entries(value)) {
        const field = `${pointer}/${escapeToken(key)}`;
        if (!Object.hasOwn(declared.props, key)) {
          issues.push({ path: `${base}${field}`, code: "mock_shape_mismatch", message: `${field} is not a field ${type} emits; at ${pointer === "" ? "the root" : pointer} it emits ${Object.keys(declared.props).join(", ") || "nothing"}.` });
          continue;
        }
        props[key] = restrict(inner, declared.props[key]!, base, field, type, issues);
      }
      return object(props);
    }
  }
}

// What two mock messages both carry. Both come from the same declared shape, so kinds agree.
function intersect(a: Shape, b: Shape): Shape {
  if (a.kind === "object" && b.kind === "object") {
    const props: Record<string, Shape> = {};
    for (const key of Object.keys(a.props)) if (Object.hasOwn(b.props, key)) props[key] = intersect(a.props[key]!, b.props[key]!);
    return object(props);
  }
  if (a.kind === "array" && b.kind === "array") return { kind: "array", items: intersect(a.items, b.items) };
  return a;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

// The step whose config holds `path`: the one with the longest matching path, or the output.
function readerAt(pipeline: any, path: string): string {
  if (path === "/output" || path.startsWith("/output/")) return "the output";
  let best: { id: string; length: number } | null = null;
  for (const step of allSteps(pipeline)) {
    if ((path === step.path || path.startsWith(`${step.path}/`)) && step.path.length > (best?.length ?? -1)) best = { id: step.config.id, length: step.path.length };
  }
  return best?.id ?? "a step";
}
