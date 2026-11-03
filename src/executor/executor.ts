// Runs one pipeline once: input → processors → output, one acknowledgement per batch. In v0 every
// input emits one batch, so "the batch was acknowledged" and "the run succeeded" are the same event.

import type { Fetcher } from "../components/http-fetch.ts";
import { deliver, processorFor, type StepContext } from "../components/runtime.ts";
import { RpcError } from "../protocol/errors.ts";
import { StepError, type Message, type RunInit, type RunOutcome } from "./messages.ts";
import { RunState } from "./run-state.ts";

export interface ExecutorWorld {
  signal: AbortSignal;
  llm: StepContext["llm"];
  result: StepContext["result"];
  warn(warning: { step_id: string; message_id: string | null; code: string; message: string }): void;
  fetcher: Fetcher | null;
  network(host: string, bytes: number): void;
  denied(host: string): void;
  stepStarted(stepId: string): void;
  stepFinished(step: { step_id: string; in: number; out: number; dropped: number; duration_ms: number }): void;
}

function inputMessages(init: RunInit): Message[] {
  if (init.input_override) return init.input_override;
  const input = init.pipeline.input;
  if (input.type === "inject") {
    return input.messages.map((m: any, i: number) => ({ id: `m${i + 1}`, data: structuredClone(m.data), meta: { ...m.meta } }));
  }
  return [{ id: "m1", data: { trigger: init.trigger === "schedule" ? "schedule" : "host", scheduled_for: init.scheduled_for, run_id: init.run_id }, meta: {} }];
}

export async function execute(init: RunInit, world: ExecutorWorld): Promise<RunOutcome> {
  const startedAt = Date.now();
  const clockStart = init.clock ? Date.parse(init.clock) : null;
  const now = () => new Date(clockStart === null ? Date.now() : clockStart + (Date.now() - startedAt));
  let stepId = "input";
  let state: RunState;
  let touched = false;
  const context = (id: string): StepContext => ({
    runId: init.run_id,
    stepId: id,
    signal: world.signal,
    now,
    state,
    stateTouched: () => {
      touched = true;
    },
    warn: (messageId, code, message) => world.warn({ step_id: id, message_id: messageId, code, message }),
    llm: world.llm,
    result: world.result,
    fetcher: world.fetcher,
    network: world.network,
    denied: world.denied,
    bypassAllowlistCheck: init.test_hook?.bypass_allowlist_check === true,
  });
  const noState = { committed: false, dedupe_keys: 0 };
  try {
    state = new RunState(init.state_path, init.initial_state);
    let batch = inputMessages(init);
    world.stepFinished({ step_id: "input", in: 0, out: batch.length, dropped: 0, duration_ms: 0 });
    for (const config of init.pipeline.processors) {
      throwIfCancelled(world.signal);
      stepId = config.id;
      world.stepStarted(stepId);
      const started = Date.now();
      const incoming = batch.length;
      batch = await processorFor(config.type)(config, batch, context(stepId));
      world.stepFinished({ step_id: stepId, in: incoming, out: batch.length, dropped: Math.max(0, incoming - batch.length), duration_ms: Date.now() - started });
    }
    throwIfCancelled(world.signal);
    stepId = "output";
    world.stepStarted(stepId);
    const started = Date.now();
    await deliver(init.pipeline.output, batch, context(stepId));
    world.stepFinished({ step_id: stepId, in: batch.length, out: batch.length, dropped: 0, duration_ms: Date.now() - started });
    // Before the final report, so a host that sees "succeeded" knows the keys are on disk.
    stepId = "state";
    const committed = state.commit(touched);
    return { status: "succeeded", error: null, state: { committed, dedupe_keys: state.keyCount } };
  } catch (err) {
    return { status: cancelledBy(err, world.signal) ? "cancelled" : "failed", error: describe(err, stepId), state: noState };
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StepError("cancelled", "The run was cancelled.");
}

function cancelledBy(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof StepError && err.kind === "cancelled");
}

function describe(err: unknown, stepId: string): NonNullable<RunOutcome["error"]> {
  if (err instanceof StepError) {
    const { message_id, ...extras } = err.extras;
    return { ...extras, kind: err.kind, message: err.message, step_id: stepId, message_id: (message_id as string | undefined) ?? null };
  }
  if (err instanceof RpcError) return { ...err.extras, kind: err.kind, message: err.message, step_id: stepId, message_id: null };
  return { kind: "internal", message: `Internal error: ${(err as Error).message}`, step_id: stepId, message_id: null };
}
