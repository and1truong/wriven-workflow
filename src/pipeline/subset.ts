// Whether new permissions are within the pinned ones, field by field. Anything not a subset needs the
// person's approval again. The rules: .agents/specs/permissions.md#pinning-and-comparison.

import { canonicalJson } from "./canonical.ts";
import { parseDuration } from "./duration.ts";
import type { Permissions } from "./permissions.ts";

function atMost(next: number, pinned: number): boolean {
  return next <= pinned;
}

function llmWithin(next: Permissions["llm"], pinned: Permissions["llm"]): boolean {
  if (next === null) return true;
  if (pinned === null) return false;
  if (!atMost(next.max_calls_per_run, pinned.max_calls_per_run)) return false;
  if (next.receives_fetched_content && !pinned.receives_fetched_content) return false;
  // Null is unbounded: adding a cap narrows, removing one widens.
  if (pinned.max_cost_per_run_usd === null) return true;
  return next.max_cost_per_run_usd !== null && next.max_cost_per_run_usd <= pinned.max_cost_per_run_usd;
}

function stateWithin(next: Permissions["state"], pinned: Permissions["state"]): boolean {
  if (next === null) return true;
  if (pinned === null) return false;
  return parseDuration(next.remember) <= parseDuration(pinned.remember) && next.max_keys <= pinned.max_keys;
}

export function isSubset(next: Permissions, pinned: Permissions): boolean {
  const hosts = new Set(pinned.network.map((n) => n.host));
  return (
    next.version === pinned.version &&
    next.network.every((n) => hosts.has(n.host)) &&
    atMost(next.network_retry?.max_attempts ?? 0, pinned.network_retry?.max_attempts ?? 0) &&
    llmWithin(next.llm, pinned.llm) &&
    stateWithin(next.state, pinned.state) &&
    atMost(next.results.retry?.max_attempts ?? 0, pinned.results.retry?.max_attempts ?? 0) &&
    next.results.kind === pinned.results.kind &&
    (pinned.skips_failed_sources || !next.skips_failed_sources) &&
    (pinned.skips_failed_items || !next.skips_failed_items) &&
    (pinned.handles_failed_items || !next.handles_failed_items) &&
    atMost(next.limits.runs_per_day, pinned.limits.runs_per_day) &&
    parseDuration(next.limits.run_timeout) <= parseDuration(pinned.limits.run_timeout) &&
    canonicalJson(next.runs) === canonicalJson(pinned.runs)
  );
}

export function sentenceDiff(next: string[], current: string[]): { added: string[]; removed: string[] } {
  return { added: next.filter((s) => !current.includes(s)), removed: current.filter((s) => !next.includes(s)) };
}
