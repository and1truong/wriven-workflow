// What each component does at run time. Runs only inside a run process.

import { findPlaceholders, pointerGet, pointerSet } from "../pipeline/pointer.ts";
import { parseDuration } from "../pipeline/duration.ts";
import { RpcError } from "../protocol/errors.ts";
import { StepError, type Message } from "../executor/messages.ts";
import { httpFetch, type Fetcher } from "./http-fetch.ts";

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
  llm(request: { step_id: string; message_id: string; system?: string; messages: Array<{ role: "user"; content: string }>; max_output_tokens?: number }): Promise<any>;
  result(request: { message_id: string; result: { title: string; body: string; format: string } }): Promise<any>;
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

const template: Processor = async (config, batch) => {
  for (const message of batch) {
    // One pass over the template, so text from a fetched page that looks like a placeholder stays text.
    const text = (config.text as string).replace(PLACEHOLDER, (raw) => {
      const [placeholder] = findPlaceholders(raw).placeholders;
      if (!placeholder) return raw;
      if (placeholder.meta !== undefined) {
        const meta = message.meta[placeholder.meta];
        if (meta === undefined && config.missing !== "empty") {
          throw new StepError("unresolved_pointer", `The metadata key ${placeholder.meta} does not exist in message ${message.id}.`, { message_id: message.id });
        }
        return meta ?? "";
      }
      const found = pointerGet(message.data, placeholder.pointer!);
      if (!found.found) {
        if (config.missing === "empty") return "";
        throw new StepError("unresolved_pointer", `${placeholder.pointer} does not exist in message ${message.id}.`, { message_id: message.id });
      }
      return typeof found.value === "string" ? found.value : JSON.stringify(found.value);
    });
    write(message, config.target, text);
  }
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

const PROCESSORS: Record<string, Processor> = { http_fetch: httpFetch, template, host_llm: hostLlm };

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
