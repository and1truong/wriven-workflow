// The run report, and its published JSON Schema. Sent in `run.finished`; the host stores it.

import type { JsonSchema } from "./pipeline/json-schema.ts";

export type RunStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped";
export type RunTrigger = "host" | "schedule" | "test";

export interface ReportError {
  kind: string;
  message: string;
  step_id: string | null;
  message_id: string | null;
  retry_after: unknown;
  [extra: string]: unknown;
}

export interface ReportWarning {
  step_id: string;
  message_id: string | null;
  code: string;
  message: string;
  // The try that caught this failure.
  caught_by?: string;
}

export interface ReportLog {
  step_id: string;
  message_id: string;
  text: string;
}

export interface ReportStep {
  step_id: string;
  in: number;
  out: number;
  dropped: number;
  duration_ms: number;
  // Nested steps only: the container's id, and how many times the step ran; counts are summed.
  parent?: string;
  invocations?: number;
  // Set by pipeline.test on a step a mock replaced.
  mocked?: boolean;
  // A workflow's branches: how many messages each skipped.
  branches?: Record<string, { skipped: number }>;
}

export interface RunReport {
  report_version: 1;
  run_id: string;
  stream_id: string | null;
  stream_name: string;
  pipeline_format: string;
  permissions_hash: string;
  trigger: RunTrigger;
  scheduled_for: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string;
  status: RunStatus;
  error: ReportError | null;
  warnings: ReportWarning[];
  steps: ReportStep[];
  // Lines from `log` steps; present only when there are some.
  logs?: ReportLog[];
  llm: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    requests: Array<{ idempotency_key: string; attempt: number; provider: string | null; model: string | null; duration_ms: number }>;
  };
  network: { requests: number; bytes: number; hosts: string[]; denied: string[] };
  results: Array<{ idempotency_key: string; ref: string | null; title: string }>;
  state: { committed: boolean; dedupe_keys: number };
  sandbox: "seatbelt" | "none";
  engine_version: string;
  cancelled_at_step?: string | null;
  nothing_new?: boolean;
  resets_at?: string;
}

const time = { type: "string" };
const nullableTime = { type: ["string", "null"] };

export const REPORT_SCHEMA: JsonSchema = {
  $id: "https://wriven.dev/schemas/run-report-1.json",
  type: "object",
  additionalProperties: true,
  required: [
    "report_version", "run_id", "stream_id", "stream_name", "pipeline_format", "permissions_hash", "trigger", "scheduled_for",
    "queued_at", "started_at", "finished_at", "status", "error", "warnings", "steps", "llm", "network", "results", "state", "sandbox", "engine_version",
  ],
  properties: {
    report_version: { const: 1 },
    run_id: { type: "string" },
    stream_id: { type: ["string", "null"] },
    stream_name: { type: "string" },
    pipeline_format: { type: "string" },
    permissions_hash: { type: "string" },
    trigger: { enum: ["host", "schedule", "test"] },
    scheduled_for: nullableTime,
    queued_at: time,
    started_at: nullableTime,
    finished_at: time,
    status: { enum: ["succeeded", "failed", "timed_out", "cancelled", "skipped"] },
    error: {
      type: ["object", "null"],
      required: ["kind", "message"],
      properties: { kind: { type: "string" }, message: { type: "string" }, step_id: { type: ["string", "null"] }, message_id: { type: ["string", "null"] } },
    },
    warnings: {
      type: "array",
      items: {
        type: "object",
        required: ["step_id", "message_id", "code", "message"],
        properties: { step_id: { type: "string" }, message_id: { type: ["string", "null"] }, code: { type: "string" }, message: { type: "string" }, caught_by: { type: "string" } },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["step_id", "in", "out", "dropped", "duration_ms"],
        properties: {
          step_id: { type: "string" },
          in: { type: "integer" },
          out: { type: "integer" },
          dropped: { type: "integer" },
          duration_ms: { type: "number" },
          parent: { type: "string" },
          invocations: { type: "integer" },
          mocked: { type: "boolean" },
          branches: { type: "object", additionalProperties: { type: "object", required: ["skipped"], properties: { skipped: { type: "integer" } } } },
        },
      },
    },
    logs: {
      type: "array",
      items: {
        type: "object",
        required: ["step_id", "message_id", "text"],
        properties: { step_id: { type: "string" }, message_id: { type: "string" }, text: { type: "string" } },
      },
    },
    llm: {
      type: "object",
      required: ["calls", "input_tokens", "output_tokens", "cost_usd", "requests"],
      properties: {
        calls: { type: "integer" },
        input_tokens: { type: "integer" },
        output_tokens: { type: "integer" },
        cost_usd: { type: ["number", "null"] },
        requests: {
          type: "array",
          items: {
            type: "object",
            required: ["idempotency_key", "attempt", "provider", "model", "duration_ms"],
            properties: { idempotency_key: { type: "string" }, attempt: { type: "integer", minimum: 1 }, provider: { type: ["string", "null"] }, model: { type: ["string", "null"] }, duration_ms: { type: "number" } },
          },
        },
      },
    },
    network: {
      type: "object",
      required: ["requests", "bytes", "hosts", "denied"],
      properties: { requests: { type: "integer" }, bytes: { type: "integer" }, hosts: { type: "array", items: { type: "string" } }, denied: { type: "array", items: { type: "string" } } },
    },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["idempotency_key", "ref", "title"],
        properties: { idempotency_key: { type: "string" }, ref: { type: ["string", "null"] }, title: { type: "string" } },
      },
    },
    state: { type: "object", required: ["committed", "dedupe_keys"], properties: { committed: { type: "boolean" }, dedupe_keys: { type: "integer" } } },
    sandbox: { enum: ["seatbelt", "none"] },
    engine_version: { type: "string" },
    cancelled_at_step: { type: ["string", "null"] },
    nothing_new: { type: "boolean" },
    resets_at: { type: "string" },
  },
};
