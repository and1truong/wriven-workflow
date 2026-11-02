# engine-10: `runs_per_day`, `llm_cost_per_run_usd`, host ceilings, `skipped` reports

**Spec:** [pipeline-format](../specs/pipeline-format.md#limits), [host-protocol](../specs/host-protocol.md) (`ceilings`, `llm_reports_cost`, `runs_per_day_exceeded`), [permissions](../specs/permissions.md) (limit and cost sentences). [ADR 008](../decisions/008-mandatory-limits.md).

**To build:** Rolling 24-hour run counter per stream (started runs, including failures) with a `skipped` report carrying `resets_at`; cost accumulation from `usage.cost_usd` and `budget_exceeded` when the cap is passed (checked after each `host.llm` response, before the next call); host ceilings at `initialize` lowering compiled-in ones, error when higher; sentence variants for cost enforceable vs not.

**Blocked by:** [engine-03](engine-03-minimal-run-host-llm-host-result.md).

**Verification:** Third trigger within 24 h under `runs_per_day: 2` → `skipped` with `resets_at`; fake clock past the window → runs again. Fake host returning `cost_usd` summing past the cap → `budget_exceeded` with `limit`/`value`, no further `host.llm`. Host declaring `llm_reports_cost: false` → sentence "Cost limit: not enforceable with this provider." and no cost enforcement. `ceilings.llm_calls_per_run: 100` at `initialize` → error; `10` → pipelines asking for 11 fail validation.

**Status:** not started

- [ ] Rolling counter, `skipped`, `resets_at`
- [ ] Cost accumulation and cap
- [ ] Host ceilings
- [ ] Sentences
