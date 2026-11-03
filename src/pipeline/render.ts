// Renders a permissions object into the English sentences a person approves. Code writes these, never
// the model. Sentence templates: .agents/specs/permissions.md.

import { durationWords, groupThousands } from "./duration.ts";
import { MISSED_SENTENCES, scheduleSentence } from "../scheduler/render.ts";
import type { Permissions } from "./permissions.ts";

export interface RenderContext {
  displayName: string;
  sandboxAvailable: boolean;
  llmReportsCost: boolean;
}

export const DEFAULT_DISPLAY_NAME = "the host";

function count(n: number, noun: string): string {
  return `${groupThousands(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function usd(amount: number): string {
  const digits = amount >= 0.01 ? 2 : 4;
  return `$${amount.toFixed(digits)}`;
}

export function renderPermissions(permissions: Permissions, ctx: RenderContext): string[] {
  const lines =
    permissions.runs.kind === "schedule"
      ? [scheduleSentence(permissions.runs.cron!, permissions.runs.timezone!), MISSED_SENTENCES[permissions.runs.missed!]!]
      : [`Runs: when ${ctx.displayName} asks.`];
  lines.push(
    permissions.network.length === 0
      ? "Fetches from: nowhere."
      : `Fetches from: ${permissions.network.map((n) => n.host).join(", ")} (GET only, over HTTPS).`,
  );
  if (permissions.network_retry) lines.push(`Retries a failed fetch up to ${permissions.network_retry.max_attempts} times.`);
  if (permissions.skips_failed_sources) lines.push("Skips a source that cannot be fetched or read that day, and says so in the run report.");
  if (permissions.skips_failed_items) lines.push("Skips an item that fails at a step, and says so in the run report.");
  if (permissions.handles_failed_items) lines.push("When an item fails at a step, handles it with fallback steps instead of stopping, and says so in the run report.");
  if (permissions.state) {
    lines.push(`Keeps: a list of items already seen, on this Mac, for ${durationWords(permissions.state.remember)} (up to ${count(permissions.state.max_keys, "item")}).`);
  }
  if (permissions.llm) {
    lines.push(`Uses: the AI provider of this chat, at most ${count(permissions.llm.max_calls_per_run, "request")} per run.`);
    if (permissions.llm.max_cost_per_run_usd !== null) {
      lines.push(
        ctx.llmReportsCost
          ? `Stops a run that would cost more than ${usd(permissions.llm.max_cost_per_run_usd)}, when the provider reports cost.`
          : "Cost limit: not enforceable with this provider.",
      );
    }
    if (permissions.llm.receives_fetched_content) lines.push("Sends fetched web content to the AI provider.");
  }
  lines.push(`Writes results to: ${permissions.results.kind === "host" ? ctx.displayName : "nowhere"}.`);
  if (permissions.results.retry) lines.push(`Retries writing a result up to ${permissions.results.retry.max_attempts} times.`);
  lines.push(`Limits: at most ${count(permissions.limits.runs_per_day, "run")} per day; each run stops after ${durationWords(permissions.limits.run_timeout)}.`);
  lines.push("Does not: run programs, read or write your files, listen for connections, send data anywhere not listed above, or hold any API key.");
  lines.push(ctx.sandboxAvailable ? "OS sandbox: on (macOS Seatbelt)." : "OS sandbox: unavailable on this Mac; only the engine's own checks apply.");
  return lines;
}
