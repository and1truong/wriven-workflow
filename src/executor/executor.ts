// Runs one pipeline once: input → processors → output, one acknowledgement per batch. In v0 every
// input emits one batch, so "the batch was acknowledged" and "the run succeeded" are the same event.

import type { Fetcher } from "../components/http-fetch.ts";
import { deliver, processorFor, type FailureHandler, type StepContext } from "../components/runtime.ts";
import { RpcError } from "../protocol/errors.ts";
import { StepError, type Message, type RunInit, type RunOutcome } from "./messages.ts";
import { RunState } from "./run-state.ts";
import { childLists, walkSteps } from "../pipeline/tree.ts";

export interface ExecutorWorld {
  signal: AbortSignal;
  llm: StepContext["llm"];
  result: StepContext["result"];
  warn(warning: { step_id: string; message_id: string | null; code: string; message: string; caught_by?: string }): void;
  log(entry: { step_id: string; message_id: string; text: string }): void;
  fetcher: Fetcher | null;
  network(host: string, bytes: number): void;
  denied(host: string): void;
  stepStarted(stepId: string): void;
  stepFinished(step: { step_id: string; in: number; out: number; dropped: number; duration_ms: number; parent?: string; invocations?: number }): void;
}

interface NestedStats {
  step_id: string;
  parent: string;
  in: number;
  out: number;
  dropped: number;
  duration_ms: number;
  invocations: number;
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
  // What `sleep` skipped under pipeline.test, so the run's clock still moves by it.
  let slept = 0;
  const now = () => new Date((clockStart === null ? Date.now() : clockStart + (Date.now() - startedAt)) + slept);
  let stepId = "input";
  // The innermost step a failure came from; containers rethrow what their steps threw.
  let failedAt: string | null = null;
  let state: RunState;
  let touched = false;
  // Nested steps run once per invocation of their container; the report sums them.
  const nested = new Map<string, NestedStats>();
  const context = (id: string, onFailure: FailureHandler | null, iterations: number[]): StepContext => ({
    runId: init.run_id,
    stepId: id,
    signal: world.signal,
    now,
    state,
    stateTouched: () => {
      touched = true;
    },
    warn: (messageId, code, message) => world.warn({ step_id: id, message_id: messageId, code, message }),
    log: (messageId, text) => world.log({ step_id: id, message_id: messageId, text }),
    sleep: async (ms) => {
      if (init.trigger === "test") slept += ms;
      else await abortableSleep(ms, world.signal);
    },
    runSteps: (steps, batch, options) =>
      runList(steps, batch, id, options?.onFailure ?? onFailure, options?.iteration === undefined ? iterations : [...iterations, options.iteration]),
    iterations,
    unitFailed: (unit, err) => {
      if (onFailure === null || !isCatchable(err)) throw err;
      onFailure(unit, err, id);
    },
    warnFor: (warning) => world.warn(warning),
    testing: init.trigger === "test",
    llm: world.llm,
    result: world.result,
    fetcher: world.fetcher,
    network: world.network,
    denied: world.denied,
    bypassAllowlistCheck: init.test_hook?.bypass_allowlist_check === true,
  });
  const runStep = async (config: any, batch: Message[], parent: string | null, onFailure: FailureHandler | null, iterations: number[]): Promise<Message[]> => {
    throwIfCancelled(world.signal);
    stepId = config.id;
    world.stepStarted(config.id);
    const started = Date.now();
    let out: Message[];
    try {
      // on_error: skip is a try with an empty catch around this one step, reported as v0 did.
      const handler: FailureHandler | null =
        config.on_error === "skip" ? (unit, err, stepId) => world.warn({ step_id: stepId, message_id: unit.id, code: err.kind, message: err.message }) : onFailure;
      out = await processorFor(config.type)(config, batch, context(config.id, handler, iterations));
    } catch (err) {
      failedAt ??= config.id;
      throw err;
    }
    const counts = { in: batch.length, out: out.length, dropped: Math.max(0, batch.length - out.length), duration_ms: Date.now() - started };
    if (parent === null) {
      world.stepFinished({ step_id: config.id, ...counts });
      // A container's own entry first, then the steps it holds in document order.
      for (const inner of walkSteps(childLists(config).flatMap((l) => l.steps), "")) {
        const stats = nested.get(inner.config.id);
        if (stats) world.stepFinished(stats);
      }
    } else {
      const stats = nested.get(config.id) ?? { step_id: config.id, parent, in: 0, out: 0, dropped: 0, duration_ms: 0, invocations: 0 };
      stats.in += counts.in;
      stats.out += counts.out;
      stats.dropped += counts.dropped;
      stats.duration_ms += counts.duration_ms;
      stats.invocations++;
      nested.set(config.id, stats);
    }
    return out;
  };
  const runList = async (steps: any[], batch: Message[], parent: string | null, onFailure: FailureHandler | null, iterations: number[]): Promise<Message[]> => {
    let current = batch;
    for (const config of steps) current = await runStep(config, current, parent, onFailure, iterations);
    return current;
  };
  const noState = { committed: false, dedupe_keys: 0 };
  try {
    state = new RunState(init.state_path, init.initial_state);
    let batch = inputMessages(init);
    world.stepFinished({ step_id: "input", in: 0, out: batch.length, dropped: 0, duration_ms: 0 });
    batch = await runList(init.pipeline.processors, batch, null, null, []);
    throwIfCancelled(world.signal);
    stepId = "output";
    world.stepStarted(stepId);
    const started = Date.now();
    await deliver(init.pipeline.output, batch, context(stepId, null, []));
    world.stepFinished({ step_id: stepId, in: batch.length, out: batch.length, dropped: 0, duration_ms: Date.now() - started });
    // Before the final report, so a host that sees "succeeded" knows the keys are on disk.
    stepId = "state";
    const committed = state.commit(touched);
    return { status: "succeeded", error: null, state: { committed, dedupe_keys: state.keyCount } };
  } catch (err) {
    return { status: cancelledBy(err, world.signal) ? "cancelled" : "failed", error: describe(err, failedAt ?? stepId), state: noState };
  }
}

// Failures of the run itself, of the host, or of the test are never a unit's to recover from.
const UNCATCHABLE = new Set(["cancelled", "fixture_missing", "internal", "budget_exceeded", "timed_out", "memory_limit"]);

function isCatchable(err: unknown): err is StepError {
  return err instanceof StepError && err.extras.from_host !== true && !UNCATCHABLE.has(err.kind);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(new StepError("cancelled", "The run was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }, ms);
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StepError("cancelled", "The run was cancelled.");
}

function cancelledBy(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof StepError && err.kind === "cancelled");
}

function describe(err: unknown, stepId: string): NonNullable<RunOutcome["error"]> {
  if (err instanceof StepError) {
    const { message_id, from_host: _fromHost, ...extras } = err.extras;
    return { ...extras, kind: err.kind, message: err.message, step_id: stepId, message_id: (message_id as string | undefined) ?? null };
  }
  if (err instanceof RpcError) return { ...err.extras, kind: err.kind, message: err.message, step_id: stepId, message_id: null };
  return { kind: "internal", message: `Internal error: ${(err as Error).message}`, step_id: stepId, message_id: null };
}
