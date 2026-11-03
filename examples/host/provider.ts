// How this host answers `host.llm`: one provider call per request, with the host's own key, mapped
// to the protocol's typed errors. The engine never sees a key or names a provider.

import Anthropic from "@anthropic-ai/sdk";
import { HostError } from "./rpc.ts";

export interface Completion {
  text: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd?: number };
  provider: string;
  model: string;
  finished: "stop" | "length";
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  signal: AbortSignal;
}

export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

// Published per-token prices in USD per million tokens. Source: the claude-api skill's model table,
// cached 2026-10-06; not verified against https://platform.claude.com/docs/en/about-claude/pricing.
// An estimate for the run report, not the bill. A model missing here reports no cost.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export interface AnthropicProviderOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<AnthropicProviderOptions["effort"]>;

  constructor(options: AnthropicProviderOptions = {}) {
    // No SDK retries: a failure reaches the engine as a typed error and shows in the run report,
    // the same "no retry by default" rule the engine follows. The timeout stays under the
    // host_response timeout this host declares at initialize (300 s).
    this.client = options.client ?? new Anthropic({ maxRetries: 0, timeout: 240_000 });
    this.model = options.model ?? "claude-opus-5-5";
    // Pipeline steps are summaries and classifications; low effort keeps them fast and cheap.
    this.effort = options.effort ?? "low";
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens ?? 16_000,
          ...(request.system ? { system: request.system } : {}),
          messages: [{ role: "user", content: request.prompt }],
          output_config: { effort: this.effort },
          // A request the safety classifiers decline is re-run on a model chosen by category.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: request.signal },
      );
    } catch (err) {
      throw toHostError(err);
    }
    if (response.stop_reason === "refusal") {
      throw new HostError("provider_refused", "The AI provider declined this request.", {
        provider: this.name,
        reason: response.stop_details?.category ?? "refusal",
      });
    }
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const { input_tokens, output_tokens } = response.usage;
    const cost = estimateCost(response.model, input_tokens, output_tokens);
    return {
      text,
      usage: { input_tokens, output_tokens, ...(cost !== undefined ? { cost_usd: cost } : {}) },
      provider: this.name,
      // The model that served the reply, which differs from the one asked for after a fallback.
      model: response.model,
      finished: response.stop_reason === "max_tokens" ? "length" : "stop",
    };
  }
}

// Provider failures, mapped to the kinds an unattended run needs to decide what to show.
export function toHostError(err: unknown): HostError {
  const provider = "anthropic";
  if (err instanceof Anthropic.APIUserAbortError) return new HostError("cancelled", "The host stopped the request.", { reason: "cancelled" });
  // APIConnectionError is a subclass of APIError in this SDK, so it is checked first.
  if (err instanceof Anthropic.APIConnectionError) {
    return new HostError("provider_unavailable", "The AI provider could not be reached.", { provider });
  }
  if (err instanceof Anthropic.APIError) {
    const retryAfter = retryAfterOf(err.headers);
    const extras = { provider, ...(retryAfter ? { retry_after: retryAfter } : {}) };
    switch (err.type) {
      case "authentication_error":
        return new HostError("credentials_rejected", "The AI provider refused the API key.", { provider });
      case "permission_error":
        return new HostError("credentials_rejected", "The API key is not allowed to use this model.", { provider });
      case "billing_error":
        return new HostError("quota_exhausted", "The AI provider account has no credit left.", extras);
      case "rate_limit_error":
        return new HostError("rate_limited", "The AI provider is rate limiting requests.", extras);
      case "overloaded_error":
      case "api_error":
        return new HostError("provider_unavailable", "The AI provider is temporarily unavailable.", { provider, status: err.status });
      default:
        if (typeof err.status === "number" && err.status >= 500) {
          return new HostError("provider_unavailable", "The AI provider is temporarily unavailable.", { provider, status: err.status });
        }
        return new HostError("host_error", `The AI provider rejected the request: ${err.message}`, { reason: err.type ?? `http_${err.status}` });
    }
  }
  // The SDK raises a plain Error, without a class to test, when no credential is configured at all
  // (no ANTHROPIC_API_KEY, no ANTHROPIC_AUTH_TOKEN, no `ant auth login` profile).
  if (err instanceof Error && err.message.startsWith("Could not resolve authentication method")) {
    return new HostError("credentials_missing", "No API key is configured for the AI provider.", { provider });
  }
  return new HostError("host_error", `The host failed to call the AI provider: ${(err as Error)?.message ?? String(err)}`, { reason: "provider_call_failed" });
}

// `retry-after` in seconds, as an RFC 3339 time the report can show ("try again after 14:00").
function retryAfterOf(headers: Headers | undefined): string | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// A provider with no network, for tests and for trying the host without a key: echoes the prompt,
// or answers from a list in order (the last one repeats).
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly calls: CompletionRequest[] = [];
  private index = 0;

  constructor(
    private readonly replies?: string[],
    private readonly failWith?: HostError,
  ) {}

  async complete(request: CompletionRequest): Promise<Completion> {
    this.calls.push(request);
    if (this.failWith) throw this.failWith;
    const text = this.replies ? this.replies[Math.min(this.index++, this.replies.length - 1)]! : `[echo] ${request.prompt}`;
    return {
      text,
      usage: { input_tokens: Math.ceil(request.prompt.length / 4), output_tokens: Math.ceil(text.length / 4) },
      provider: this.name,
      model: "scripted-1",
      finished: "stop",
    };
  }
}
