# engine-09: `schedule` input, cron with time zones and DST rules, missed-run policy, `schedule.preview`

**Spec:** [scheduling](../../../specs/scheduling.md), [pipeline-format](../../../specs/pipeline-format.md) (`schedule`), [permissions](../../../specs/permissions.md) (schedule sentences).

**To build:** Cron parser (5 fields, lists, ranges, steps, names), IANA zone validation, occurrence computation with the spec's DST rules, `schedule.preview`, the scheduler loop (active only with `clock: engine`), `last_handled` bookmarks, `missed: skip|run_once|run_all` with the 30 s grace, pause/resume/update/delete/restart behaviour, the occurrences-per-day check against `runs_per_day`, cron-to-English rendering for the common forms. Fake clock for all tests.

**Blocked by:** [engine-03](engine-03-minimal-run-host-llm-host-result.md) (needs runs; independent of network components).

**Verification:** All acceptance criteria of [scheduling](../../../specs/scheduling.md#acceptance-criteria): the Brisbane weekday example; Sydney spring-forward and fall-back days; `run_once`/`run_all`/`skip` with three missed occurrences; pause across occurrences then resume → nothing enqueued; `*/5` vs `runs_per_day: 2` → validation error naming 288; `clock: host` + `schedule` input → `schedule_requires_engine_clock`. Table-driven DST tests for Sydney, London, New York, Brisbane, UTC. Rendering: `0 8 * * 1-5` → "every weekday at 08:00 (Australia/Brisbane)".

**Status:** done 2026-11-03

- [x] Cron parser and zone arithmetic; `schedule.preview`
- [x] Scheduler loop with fake clock; bookmarks; missed policy
- [x] Pause/resume/update/restart semantics
- [x] Per-day check; English rendering
