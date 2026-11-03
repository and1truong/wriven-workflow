// The private protocol between the engine and a run process, and the unit that travels through a
// pipeline. Both ends are this binary, so nothing here is a compatibility promise.

import type { StateFile } from "./run-state.ts";

export interface Message {
  id: string;
  data: any;
  meta: Record<string, string>;
}

export interface RunInit {
  run_id: string;
  stream_id: string | null;
  pipeline: any;
  trigger: "host" | "schedule" | "test";
  scheduled_for: string | null;
  // The instant the run believes is "now" at its start, when a clock is injected.
  clock: string | null;
  input_override: Message[] | null;
  proxy: { port: number; token: string } | null;
  // RLIMIT_CPU for the process.
  cpu_limit_s: number;
  // Where the stream's state lives; null when nothing may be written (tests).
  state_path: string | null;
  initial_state: StateFile | null;
  // A test's mocks by step id, as cases. host_llm's replies are answered by the harness from the case
  // the run process picked.
  mocks?: Record<string, { cases: Array<{ when?: unknown; messages?: Array<{ data: unknown; meta?: Record<string, string> }>; fail?: { code: string; message?: string }; replies?: string[] }> }> | null;
  // A test's fake pages. When set, the run has no network at all.
  fixtures: Record<string, { status?: number; content_type?: string; body?: string; headers?: Record<string, string> }> | null;
  // Set only by tests in this repository, through the supervisor; no RPC reaches it.
  test_hook?: { allocate_mb?: number; delay_ms?: number; spin?: boolean; cpu_limit_s?: number; forge_requests?: Array<{ method: string; params: unknown }>; bypass_allowlist_check?: boolean; tls_ca?: string };
}

export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  error: { kind: string; message: string; step_id: string | null; message_id: string | null; [extra: string]: unknown } | null;
  state: { committed: boolean; dedupe_keys: number };
}

// A failure that ends a run, with where it happened.
export class StepError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
