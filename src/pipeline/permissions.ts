// Derives the permissions object from a pipeline. There is no field in the format for the agent to
// declare them; see .agents/decisions/005-permissions-derived-and-pinned.md.

import { COMPONENT_BY_TYPE } from "../components/definitions.ts";
import { parseDuration } from "./duration.ts";

export interface Permissions {
  version: 1;
  runs: { kind: "host" | "schedule"; cron?: string; timezone?: string; missed?: string };
  network: Array<{ host: string; scheme: "https"; methods: ["GET"] }>;
  network_retry: { max_attempts: number } | null;
  llm: { max_calls_per_run: number; max_cost_per_run_usd: number | null; receives_fetched_content: boolean } | null;
  results: { kind: "host" | "none"; retry: { max_attempts: number } | null };
  state: { kind: "dedupe"; remember: string; max_keys: number } | null;
  skips_failed_sources: boolean;
  limits: { runs_per_day: number; run_timeout: string };
  denied: string[];
}

export interface PermissionsDraft extends Permissions {
  // Fetches so far in pipeline order, for `receives_fetched_content`.
  fetched: boolean;
  llmLimits: { llm_calls_per_run: number; llm_cost_per_run_usd?: number };
}

const DENIED = ["subprocess", "filesystem_outside_state", "network_outside_list", "inbound_network", "provider_keys"];

export function derivePermissions(pipeline: any): Permissions {
  const draft: PermissionsDraft = {
    version: 1,
    runs: { kind: "host" },
    network: [],
    network_retry: null,
    llm: null,
    results: { kind: "none", retry: null },
    state: null,
    skips_failed_sources: false,
    limits: { runs_per_day: pipeline.limits.runs_per_day, run_timeout: pipeline.limits.run_timeout },
    denied: DENIED,
    fetched: false,
    llmLimits: pipeline.limits,
  };
  for (const component of [pipeline.input, ...pipeline.processors, pipeline.output]) {
    COMPONENT_BY_TYPE.get(component.type)?.permissions?.(component, draft);
  }
  draft.network.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  const { fetched: _fetched, llmLimits: _llmLimits, ...permissions } = draft;
  return permissions;
}

export function runTimeoutMs(permissions: Permissions): number {
  return parseDuration(permissions.limits.run_timeout);
}
