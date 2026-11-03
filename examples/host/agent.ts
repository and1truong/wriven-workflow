// The host's client-side tool loop: the person talks to a model, the model calls the engine's
// `workflow_*` tools, the host runs each as an RPC method and hands back `tool_result`. The model
// can create and change streams but never approve them; approval is the person's, outside this
// loop. Encoding per provider: docs/host-integration.md, "Tools".

import Anthropic from "@anthropic-ai/sdk";
import type { ExampleHost } from "./host.ts";
import { EngineError } from "./rpc.ts";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

// The one call the loop makes. Tests replace it with a script.
export interface ModelClient {
  create(params: CreateParams): Promise<Message>;
}

export function anthropicModelClient(client = new Anthropic()): ModelClient {
  return { create: (params) => client.beta.messages.create(params) };
}

export interface AgentOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  // Called for each tool call, for the terminal to show what the model is doing.
  onToolCall?(name: string, input: unknown, isError: boolean): void;
  maxSteps?: number;
}

export interface AgentTurn {
  text: string;
  stopReason: string | null;
  // Streams the model created or widened in this turn; each needs the person's approval.
  awaitingApproval: string[];
}

export class Agent {
  // Append-only: every response goes back verbatim, thinking blocks included.
  readonly messages: MessageParam[] = [];
  private readonly tools: Anthropic.Beta.BetaTool[];
  private readonly methodByTool = new Map<string, string>();

  constructor(
    private readonly host: ExampleHost,
    private readonly client: ModelClient,
    private readonly options: AgentOptions = {},
  ) {
    // The engine publishes its tools at initialize. `method` stays with the host.
    this.tools = host.init.tools.map((tool: any) => {
      this.methodByTool.set(tool.name, tool.method);
      return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
    });
  }

  // One turn of the person. `note` is what the host tells the model about things that happened
  // outside the conversation (an approval, a refusal), as a system message, never a tool result.
  async send(text: string, note?: string): Promise<AgentTurn> {
    this.messages.push({ role: "user", content: text });
    if (note) this.messages.push({ role: "system", content: note });
    const awaitingApproval = new Set<string>();
    const maxSteps = this.options.maxSteps ?? 25;

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.client.create({
        model: this.options.model ?? "claude-opus-5-5",
        max_tokens: 16_000,
        system: SYSTEM_PROMPT(this.host.init),
        tools: this.tools,
        messages: this.messages,
        output_config: { effort: this.options.effort ?? "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      this.messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") {
        return { text: textOf(response), stopReason: response.stop_reason, awaitingApproval: [...awaitingApproval] };
      }

      // All results of one response go back in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { content, isError, pendingStream } = await this.runTool(block.name, block.input);
        if (pendingStream) awaitingApproval.add(pendingStream);
        this.options.onToolCall?.(block.name, block.input, isError);
        results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      }
      this.messages.push({ role: "user", content: results });
    }
    return { text: `Stopped after ${maxSteps} steps without an answer.`, stopReason: null, awaitingApproval: [...awaitingApproval] };
  }

  private async runTool(name: string, input: unknown): Promise<{ content: string; isError: boolean; pendingStream?: string }> {
    const method = this.methodByTool.get(name);
    if (!method) return { content: JSON.stringify({ error: { kind: "method_not_found", message: `There is no tool named ${name}.` } }), isError: true };
    try {
      const result = await this.host.call(method, input);
      // The model gets `tool_result`: shaped for it, at most 32 KiB, and without the
      // permissions_hash, which only the host may use to approve.
      const pendingStream = result?.status === "pending_approval" ? result.stream_id : undefined;
      return { content: JSON.stringify(result.tool_result ?? result), isError: false, pendingStream };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      const { kind, errors } = err.data as { kind: string; errors?: unknown[] };
      // Validation errors carry paths the model repairs from.
      return { content: JSON.stringify({ error: { kind, message: err.message, ...(errors ? { errors } : {}) } }), isError: true };
    }
  }
}

function textOf(response: Message): string {
  return response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

const SYSTEM_PROMPT = (init: any) =>
  [
    "You are the assistant in a desktop app that can set up automations for the person with the workflow_* tools.",
    "When they ask for work that should repeat or run unattended, build a pipeline: read the components, validate, test with fixtures and a mocked model, then create it as a stream.",
    "The person approves each automation's permissions in the app, outside this conversation. After workflow_create_stream or a workflow_update_stream that needs approval, tell them in two or three sentences what the automation will do and what it is allowed to do, then stop.",
    "This app owns the clock and runs automations when the person asks, so pipelines use the host_trigger input, never schedule.",
    `Engine ceilings: ${JSON.stringify(init.ceilings)}.`,
  ].join("\n");
