// The tools a host forwards to its model. Each maps 1:1 onto a method, and every input_schema stays
// inside what Anthropic, Gemini and OpenRouter all accept: .agents/specs/agent-surface.md.

import { truncateResult } from "./truncate.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  method: string;
}

const PIPELINE = { type: "object", description: "A wriven-workflow pipeline document. Get the full schema from workflow_list_components." };
const STREAM_ID = { type: "string", description: "The id of the automation, from workflow_create_stream or workflow_list_streams." };

export const TOOLS: ToolDefinition[] = [
  {
    name: "workflow_list_components",
    method: "components.list",
    description: "List the components a pipeline can be built from, with the configuration each accepts and the engine's limits. Call this first if you have not written a pipeline in this conversation.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", description: "Only list this kind of component.", enum: ["input", "processor", "output"] } },
      required: [],
    },
  },
  {
    name: "workflow_validate_pipeline",
    method: "pipeline.validate",
    description: "Check a pipeline without running it. Returns every error with its path, and the permissions the automation would have, in plain English. Fix every error before going on; the messages say what is wrong.",
    input_schema: { type: "object", properties: { pipeline: PIPELINE }, required: ["pipeline"] },
  },
  {
    name: "workflow_test_pipeline",
    method: "pipeline.test",
    description: "Run a pipeline once against fake input, a fake model and fake web pages. Nothing is delivered or remembered and no money is spent. Supply the XML for each URL in fixtures. Do this before workflow_create_stream, and check the prompt in llm_requests is what you meant.",
    input_schema: {
      type: "object",
      properties: {
        pipeline: PIPELINE,
        input: { type: "object", description: "Replaces what the input component emits: { messages: [{ data, meta }] }." },
        llm: { type: "object", description: 'How the fake model answers: { mode: "mock", responses: [text] } in order, the last repeating, or { mode: "echo" }, the default, which returns the prompt.' },
        fixtures: { type: "object", description: "Fake web pages by URL: { url: { status, content_type, body } }. A URL without one fails with fixture_missing." },
        network: { type: "string", description: "mock uses fixtures. live fetches for real, only if the host allows it.", enum: ["mock", "live"] },
        clock: { type: "string", description: "An RFC 3339 instant the run believes is now." },
        state: { type: "object", description: "Keys the run should believe it has already seen: { seen: { step_id: { key: RFC 3339 } } }." },
        mocks: {
          type: "object",
          description:
            "Replace processor steps by id: { step_id: { messages: [{ data, meta? }] } } emitted per unit instead of running the step (per URL for http_fetch), or { replies: [text] } for a host_llm, whose prompt is still rendered and counted. Mock messages need only the fields later steps read.",
        },
        run_embedded: { type: "boolean", description: "Run the pipeline's own tests[] instead, and report each." },
      },
      required: ["pipeline"],
    },
  },
  {
    name: "workflow_create_stream",
    method: "stream.create",
    description: "Install a validated pipeline as an automation. Call workflow_validate_pipeline first and fix every error. The result lists the permissions the automation will have, in plain English; the person must approve them in the app before anything runs, so tell them what you created and stop. Use start_paused: true when the person wants to review before the first run.",
    input_schema: {
      type: "object",
      properties: { pipeline: PIPELINE, start_paused: { type: "boolean", description: "Stay paused after approval." } },
      required: ["pipeline"],
    },
  },
  {
    name: "workflow_update_stream",
    method: "stream.update",
    description: "Change an automation. If its permissions stay within what the person approved it applies at once; otherwise it waits for their approval and the old version stops running until then, and diff shows what changes. Tell the person when that happens.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID, pipeline: PIPELINE }, required: ["stream_id", "pipeline"] },
  },
  {
    name: "workflow_pause_stream",
    method: "stream.pause",
    description: "Stop an automation from running until it is resumed. A run in progress finishes.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID }, required: ["stream_id"] },
  },
  {
    name: "workflow_resume_stream",
    method: "stream.resume",
    description: "Let a paused automation run again. Runs missed while it was paused are not made up.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID }, required: ["stream_id"] },
  },
  {
    name: "workflow_delete_stream",
    method: "stream.delete",
    description: "Remove an automation and what it remembers. A run in progress is cancelled. This cannot be undone, so be sure the person asked for it.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID }, required: ["stream_id"] },
  },
  {
    name: "workflow_list_streams",
    method: "stream.list",
    description: "List the automations, with their status, next run and permissions in plain English.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "workflow_get_stream",
    method: "stream.get",
    description: "Read one automation, including its pipeline. Start here before changing it with workflow_update_stream.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID }, required: ["stream_id"] },
  },
  {
    name: "workflow_run_now",
    method: "run.trigger",
    description: "Start an approved automation now, on top of its schedule. It counts against its runs per day.",
    input_schema: { type: "object", properties: { stream_id: STREAM_ID }, required: ["stream_id"] },
  },
];

export const HOST_TOOLS_SUGGESTED = [
  {
    name: "workflow_list_runs",
    description: "The host owns run history, so this tool is the host's to implement: { stream_id?, limit? } → { runs: [report summaries] }.",
    input_schema: {
      type: "object",
      properties: { stream_id: STREAM_ID, limit: { type: "integer", description: "How many runs, newest first." } },
      required: [],
    },
  },
];

export const MAX_TOOL_RESULT_BYTES = 32 * 1024;

const APPROVAL_NEEDED = "The person must approve these permissions in the host before the automation runs.";

function row(s: any) {
  return { stream_id: s.stream_id, name: s.name, status: s.status, next_run: s.next_run, permission_sentences: s.permission_sentences };
}

// What the model sees of a method's result: no hashes, nothing it could approve with, at most 32 KiB.
function shape(method: string, result: any): unknown {
  switch (method) {
    case "pipeline.validate":
      return { valid: result.valid, errors: result.errors, warnings: result.warnings, ...(result.rendered ? { permission_sentences: result.rendered } : {}) };
    case "pipeline.test":
      return result.tests
        ? { status: result.status, passed: result.passed, failed: result.failed, tests: result.tests }
        : { status: result.status, results: result.results, llm_requests: result.llm_requests, warnings: result.report.warnings, ...(result.report.error ? { error: result.report.error } : {}), steps: result.report.steps };
    case "stream.create":
      return { stream_id: result.stream_id, status: result.status, permission_sentences: result.rendered, next: APPROVAL_NEEDED };
    case "stream.update":
      return { stream_id: result.stream_id, status: result.status, permission_sentences: result.rendered, ...(result.diff ? { diff: result.diff, next: APPROVAL_NEEDED } : {}) };
    case "stream.list":
      return { streams: result.streams.map(row) };
    case "stream.get": {
      const { permissions: _permissions, permissions_hash: _hash, rendered, pending, ...rest } = result;
      return { ...rest, permission_sentences: rendered, ...(pending ? { pending: { permission_sentences: pending.rendered } } : {}) };
    }
    default:
      return result;
  }
}

const TOOL_METHODS = new Set(TOOLS.map((t) => t.method));

export function withToolResult(method: string, result: any): any {
  if (!TOOL_METHODS.has(method)) return result;
  return { ...result, tool_result: truncateResult(shape(method, result), MAX_TOOL_RESULT_BYTES) };
}
