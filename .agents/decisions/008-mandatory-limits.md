# ADR 008: Every pipeline carries mandatory limits; the engine and the host both enforce them

Date: 2026-11-03. Status: accepted (Hong, grilling decision 7; Wriven sidecar decision 13).

## Context

The brief asks for ceilings on unsupervised runs: run count, model calls, cost from host-reported usage. Wriven's grilling established that "about 2 requests per run" cannot be derived from a pipeline (it depends on how many items arrive) and must instead be a cap Wriven enforces at `wriven_llm`. Wriven today reads no usage from any provider (noted in its inbox, 2026-11-03), so a dollar cap is not enforceable there yet.

## Decision

- `limits` is a required top-level field with required `llm_calls_per_run`, `runs_per_day`, `run_timeout` and optional `llm_cost_per_run_usd`. Missing or out-of-range values fail validation.
- Compiled-in engine ceilings bound every field; a host may lower them at `initialize`, never raise them.
- `llm_calls_per_run` is enforced twice: by the engine before forwarding a `host.llm`, and by the host at `host.llm` against the pipeline it approved. Either side answering `budget_exceeded` fails the run.
- `runs_per_day` is enforced by the engine per stream over a rolling 24 hours, counting started runs including failures; a refused trigger is a `skipped` report with `resets_at`.
- `run_timeout` is enforced by the supervisor with a kill.
- `llm_cost_per_run_usd` is enforced only when the host reports `usage.cost_usd`; otherwise the permission sentence says the cost limit is not enforceable with this provider.
- Validation cross-checks a `schedule` cron's occurrences per day against `runs_per_day`.
- The permission sentences state the limits as numbers the person approves.

## Consequences

- An agent cannot create an unbounded automation; the worst case is `llm_calls_per_run × runs_per_day` per day, visible before approval.
- Double enforcement means a bug on one side cannot overspend.
- Hosts must count calls per run themselves, which is a small map keyed by `run_id`.
- When Wriven gains usage and cost tracking (its P1-3), the cost cap becomes enforceable with no engine change: the host starts returning `cost_usd` and declares `llm_reports_cost: true`.
