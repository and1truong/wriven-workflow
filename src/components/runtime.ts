// What each component does at run time. Runs only inside a run process.

import { findPlaceholders, pointerGet, pointerSet } from "../pipeline/pointer.ts";
import { parseDuration } from "../pipeline/duration.ts";
import { RpcError } from "../protocol/errors.ts";
import { StepError, type Message } from "../executor/messages.ts";
import { httpFetch, type Fetcher } from "./http-fetch.ts";
import { parseFeed } from "./parse-feed.ts";
import { DEDUPE_DEFAULTS, SPLIT_DEFAULT_MAX } from "./definitions.ts";
import { evaluate } from "../pipeline/condition.ts";
import type { RunState } from "../executor/run-state.ts";

export interface StepContext {
  runId: string;
  stepId: string;
  signal: AbortSignal;
  now(): Date;
  warn(messageId: string | null, code: string, message: string): void;
  fetcher: Fetcher | null;
  // Counts one finished HTTP response; the report's numbers come from here.
  network(host: string, bytes: number): void;
  // Records a host the run tried and was refused.
  denied(host: string): void;
  // Tests only: lets a request reach the proxy so its refusal can be observed.
  bypassAllowlistCheck: boolean;
  state: RunState;
  // Tells the run that state changed, so a successful run writes it.
  stateTouched(): void;
  llm(request: { step_id: string; message_id: string; system?: string; messages: Array<{ role: "user"; content: string }>; max_output_tokens?: number }): Promise<any>;
  result(request: { message_id: string; result: { title: string; body: string; format: string } }): Promise<any>;
  // Appends a line to the run report's logs.
  log(messageId: string, text: string): void;
  // Waits, or under pipeline.test moves the run's clock instead. Cancellation interrupts it.
  sleep(ms: number): Promise<void>;
  // Runs a container's nested steps on a batch.
  runSteps(steps: any[], batch: Message[]): Promise<Message[]>;
}

export type Processor = (config: any, batch: Message[], ctx: StepContext) => Promise<Message[]>;

function readString(message: Message, pointer: string, field: string): string {
  const found = pointerGet(message.data, pointer);
  if (!found.found) throw new StepError("unresolved_pointer", `${pointer} does not exist in message ${message.id}.`, { message_id: message.id });
  if (typeof found.value !== "string") throw new StepError("shape_mismatch", `${field} needs a string, but ${pointer} is not one in message ${message.id}.`, { message_id: message.id });
  return found.value;
}

function write(message: Message, pointer: string, value: unknown): void {
  if (!pointerSet(message.data, pointer, value)) {
    throw new StepError("unresolved_pointer", `The parent of ${pointer} does not exist in message ${message.id}.`, { message_id: message.id });
  }
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

// One pass over the template, so text from a fetched page that looks like a placeholder stays text.
function renderText(text: string, message: Message, missing: "error" | "empty"): string {
  return text.replace(PLACEHOLDER, (raw) => {
    const [placeholder] = findPlaceholders(raw).placeholders;
    if (!placeholder) return raw;
    if (placeholder.meta !== undefined) {
      const meta = Object.hasOwn(message.meta, placeholder.meta) ? message.meta[placeholder.meta] : undefined;
      if (meta === undefined && missing !== "empty") {
        throw new StepError("unresolved_pointer", `The metadata key ${placeholder.meta} does not exist in message ${message.id}.`, { message_id: message.id });
      }
      return meta ?? "";
    }
    const found = pointerGet(message.data, placeholder.pointer!);
    if (!found.found) {
      if (missing === "empty") return "";
      throw new StepError("unresolved_pointer", `${placeholder.pointer} does not exist in message ${message.id}.`, { message_id: message.id });
    }
    return typeof found.value === "string" ? found.value : JSON.stringify(found.value);
  });
}

const template: Processor = async (config, batch) => {
  for (const message of batch) write(message, config.target, renderText(config.text, message, config.missing ?? "error"));
  return batch;
};

const hostLlm: Processor = async (config, batch, ctx) => {
  for (const message of batch) {
    const prompt = readString(message, config.prompt, "prompt");
    let reply: any;
    try {
      reply = await ctx.llm({
        step_id: ctx.stepId,
        message_id: message.id,
        ...(config.system !== undefined ? { system: config.system } : {}),
        messages: [{ role: "user", content: prompt }],
        ...(config.max_output_tokens !== undefined ? { max_output_tokens: config.max_output_tokens } : {}),
      });
    } catch (err) {
      if (err instanceof RpcError) throw new StepError(err.kind, err.message, { ...err.extras, message_id: message.id });
      throw err;
    }
    if (reply.finished === "length") ctx.warn(message.id, "llm_truncated", "The model stopped at its output limit; the reply is cut short.");
    write(message, config.target, reply.text);
  }
  return batch;
};

const dedupe: Processor = async (config, batch, ctx) => {
  const remember = parseDuration(config.remember ?? DEDUPE_DEFAULTS.remember);
  const now = ctx.now();
  const kept = batch.filter((message) => {
    const found = pointerGet(message.data, config.key);
    if (!found.found) throw new StepError("unresolved_pointer", `${config.key} does not exist in message ${message.id}.`, { message_id: message.id });
    const key = typeof found.value === "string" ? found.value : JSON.stringify(found.value);
    return ctx.state.admit(ctx.stepId, key, now, remember);
  });
  ctx.state.trim(ctx.stepId, now, remember, config.max_keys ?? DEDUPE_DEFAULTS.max_keys);
  ctx.stateTouched();
  return kept;
};

const collect: Processor = async (config, batch, ctx) => {
  const min = config.min_items ?? 1;
  const max = config.max_items ?? 100;
  if (batch.length < min) return [];
  const first = batch[0];
  if (batch.length > max) ctx.warn(first?.id ?? null, "collect_truncated", `${batch.length} items arrived; only the first ${max} were kept.`);
  const kept = batch.slice(0, max);
  return [{ id: `${first?.id ?? ctx.stepId}.c`, data: { items: kept.map((m) => m.data), count: kept.length }, meta: { ...first?.meta } }];
};

const split: Processor = async (config, batch, ctx) => {
  const max = config.max_items ?? SPLIT_DEFAULT_MAX;
  const out: Message[] = [];
  for (const message of batch) {
    const found = pointerGet(message.data, config.field);
    if (!found.found) throw new StepError("unresolved_pointer", `${config.field} does not exist in message ${message.id}.`, { message_id: message.id });
    if (!Array.isArray(found.value)) throw new StepError("shape_mismatch", `split needs an array, but ${config.field} is not one in message ${message.id}.`, { message_id: message.id });
    if (found.value.length > max) ctx.warn(message.id, "split_truncated", `${found.value.length} items arrived; only the first ${max} were kept.`);
    found.value.slice(0, max).forEach((item, i) => out.push({ id: `${message.id}.${i}`, data: structuredClone(item), meta: { ...message.meta } }));
  }
  return out;
};

const log: Processor = async (config, batch, ctx) => {
  for (const message of batch) ctx.log(message.id, renderText(config.text, message, "empty"));
  return batch;
};

const sleep: Processor = async (config, batch, ctx) => {
  await ctx.sleep(parseDuration(config.duration));
  return batch;
};

const forEach: Processor = async (config, batch, ctx) => {
  const out: Message[] = [];
  for (const message of batch) out.push(...(await ctx.runSteps(config.steps, [message])));
  return out;
};

const filter: Processor = async (config, batch, ctx) => batch.filter((message) => evaluate(config.keep_if, message, ctx.now()));

const PROCESSORS: Record<string, Processor> = { http_fetch: httpFetch, parse_feed: parseFeed, dedupe, collect, template, host_llm: hostLlm, filter, split, log, sleep, for_each: forEach };

export function processorFor(type: string): Processor {
  const processor = PROCESSORS[type];
  if (!processor) throw new StepError("internal", `There is no processor named ${type}.`);
  return processor;
}

export async function deliver(config: any, batch: Message[], ctx: StepContext): Promise<void> {
  if (config.type === "drop") return;
  for (const message of batch) {
    const request = {
      message_id: message.id,
      result: { title: config.title as string, body: readString(message, config.body, "body"), format: (config.format ?? "markdown") as string },
    };
    const attempts = config.retry?.max_attempts ?? 1;
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.result(request);
        break;
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        if (attempt >= attempts || err.kind === "cancelled" || ctx.signal.aborted) throw new StepError(err.kind, err.message, { ...err.extras, message_id: message.id });
        ctx.warn(message.id, "result_retry", `Writing the result failed and will be tried again: ${err.message}`);
        await Bun.sleep(parseDuration(config.retry.backoff ?? "2s"));
      }
    }
  }
}
