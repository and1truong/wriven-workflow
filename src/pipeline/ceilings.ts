// Compiled-in engine ceilings. A host may lower them at `initialize`, never raise them.

import { RpcError } from "../protocol/errors.ts";
import { DURATION_PATTERN, parseDuration } from "./duration.ts";

export interface Ceilings {
  llm_calls_per_run: number;
  runs_per_day: number;
  run_timeout: string;
  run_memory_mb: number;
}

export const COMPILED_CEILINGS: Ceilings = { llm_calls_per_run: 50, runs_per_day: 48, run_timeout: "30m", run_memory_mb: 512 };

export const LIMIT_RANGES = {
  llm_calls_per_run: { minimum: 0, maximum: COMPILED_CEILINGS.llm_calls_per_run },
  runs_per_day: { minimum: 1, maximum: COMPILED_CEILINGS.runs_per_day },
  run_timeout_ms: { minimum: 30_000, maximum: parseDuration(COMPILED_CEILINGS.run_timeout) },
};

export function effectiveCeilings(requested: unknown): Ceilings {
  const ceilings = { ...COMPILED_CEILINGS };
  if (requested === undefined) return ceilings;
  if (requested === null || typeof requested !== "object" || Array.isArray(requested)) {
    throw new RpcError("invalid_params", "ceilings must be an object.", { reason: "invalid_ceilings" });
  }
  for (const [name, value] of Object.entries(requested)) {
    const above = () => new RpcError("invalid_params", `ceilings.${name} may not be above the compiled-in ${COMPILED_CEILINGS[name as keyof Ceilings]}.`, { reason: "ceiling_above_compiled" });
    const invalid = () => new RpcError("invalid_params", `ceilings.${name} is not valid.`, { reason: "invalid_ceilings" });
    if (name === "run_timeout") {
      if (typeof value !== "string" || !new RegExp(DURATION_PATTERN).test(value)) throw invalid();
      if (parseDuration(value) > parseDuration(COMPILED_CEILINGS.run_timeout)) throw above();
      ceilings.run_timeout = value;
    } else if (name === "llm_calls_per_run" || name === "runs_per_day" || name === "run_memory_mb") {
      if (!Number.isInteger(value) || (value as number) < 0) throw invalid();
      if ((value as number) > COMPILED_CEILINGS[name]) throw above();
      ceilings[name] = value as number;
    } else {
      throw invalid();
    }
  }
  return ceilings;
}
