// The private protocol between the engine and a run process, and the unit that travels through a
// pipeline. Both ends are this binary, so nothing here is a compatibility promise.

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
