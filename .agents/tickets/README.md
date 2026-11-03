# Open tickets

Vertical slices for v0, in dependency order. Each is a tracer bullet: it crosses every layer it needs and is demonstrable on its own against the fake host. Blockers are listed in each ticket; the chain below is the intended order, with 09 and 10 able to run in parallel with 04–07 once 03 is done. Finished tickets move to `completed/YYYYwNN/`.

All derive from the [specs](../specs/README.md). All twelve v0 tickets are done and live under `completed/`. The composition tickets below are open.

## Composition (post-v0)

From [composition](../specs/composition.md). Each ticket updates the specs its "Changes to other specs" entries name, in the same commit. Order: 01 and 02 in parallel; 03 after 01; then 04, 05, 06 and 08 in parallel after 03 (08 also needs 02); 07 after 05 and 06 (its worked example also needs 01 and 04); 09 last, after 04 and 08.

1. [composition-01-condition-filter](completed/2026w45/composition-01-condition-filter.md) (done) — the declarative `condition` type with shape checks; `filter`.
2. [composition-02-split-log-sleep](completed/2026w45/composition-02-split-log-sleep.md) (done) — leaf components; report `logs`; fake-clock `sleep`; `sleep_exceeds_timeout`.
3. [composition-03-nested-steps-for-each](completed/2026w45/composition-03-nested-steps-for-each.md) (done) — nested step lists, pipeline-wide ids, ceilings, id-preservation property, permission walk, report `parent`/`invocations`; sequential `for_each`.
4. [composition-04-concurrent-host-llm](completed/2026w45/composition-04-concurrent-host-llm.md) (done) — `llm_concurrency` capability, reserved budget, concurrent `for_each`, harness clamp, conformance case.
5. [composition-05-switch-shape-merging](completed/2026w45/composition-05-switch-shape-merging.md) (done) — `switch` with its ordering rule; shape merging.
6. [composition-06-unit-failures-try](composition-06-unit-failures-try.md) — per-unit failure reporting in every processor; `try` with no or empty `catch`; `on_error: skip` as sugar; `skips_failed_items`.
7. [composition-07-catch-worked-example](composition-07-catch-worked-example.md) — `catch` with error metadata; `handles_failed_items`; the spec's worked example end to end.
8. [composition-08-while](composition-08-while.md) — `while`, `changes_message_ids`, iteration-qualified `host.llm` keys.
9. [composition-09-workflow](composition-09-workflow.md) — DAG of branches, exact dependency inference, `cycle`, `write_conflict`, skips.

## Engine v0

1. [engine-01-serve-handshake-fake-host](completed/2026w45/engine-01-serve-handshake-fake-host.md) — `serve` speaks JSON-RPC over stdio, `initialize`/`shutdown`, exits on stdin EOF; `fake-host`; `--version`; `doctor` (presence check). Fixture 1.
2. [engine-02-format-validate-components](completed/2026w45/engine-02-format-validate-components.md) — pipeline format and JSON Schema, `pipeline.validate` with coded errors, limits and ceilings, permissions object/hash/sentences for `host_trigger`, `template`, `host_result`, `inject`, `drop`. Fixture 2.
3. [engine-03-minimal-run-host-llm-host-result](completed/2026w45/engine-03-minimal-run-host-llm-host-result.md) — **the first end-to-end run**: `host_trigger → template → host_llm → host_result` in an (unsandboxed) child process against the fake host, with stream lifecycle, run queue, idempotency keys, cancellation, run report. Fixtures 3, 4, 5, 7, 8.
4. [engine-04-sandbox-seatbelt-watchdog](completed/2026w45/engine-04-sandbox-seatbelt-watchdog.md) — Seatbelt profile from permissions, measured Bun allowances, memory and time watchdogs, `sandbox` policy, `doctor --self-test`. Fixture 10.
5. [engine-05-proxy-http-fetch](completed/2026w45/engine-05-proxy-http-fetch.md) — egress proxy with allowlist and token; `http_fetch` with URL rules, `on_error`, `retry`; network sentences.
6. [engine-06-parse-feed-dedupe-collect](completed/2026w45/engine-06-parse-feed-dedupe-collect.md) — `parse_feed`, `dedupe` with commit-on-success, `collect`; **the feed-digest example runs end to end**; worked-example sentences byte-exact.
7. [engine-07-approval-update-diff](completed/2026w45/engine-07-approval-update-diff.md) — approve with hash, subset rule on update, diff, rollback. Fixture 6.
8. [engine-08-pipeline-test-harness-inject](completed/2026w45/engine-08-pipeline-test-harness-inject.md) — `pipeline.test` with injected input, mocked LLM, fixtures, fake clock; embedded tests; CLI `test`.
9. [engine-09-scheduler-engine-clock](completed/2026w45/engine-09-scheduler-engine-clock.md) — `schedule` input, cron and DST, missed-run policy, `schedule.preview`. Parallel with 04–08 after 03.
10. [engine-10-limits-runs-per-day-cost](completed/2026w45/engine-10-limits-runs-per-day-cost.md) — `runs_per_day`, cost cap, host ceilings, `skipped`. Parallel with 04–08 after 03.
11. [engine-11-packaging-release](completed/2026w45/engine-11-packaging-release.md) — both architectures, signing, checksums, notices, release notes.
12. [engine-12-conformance-fixtures-host-kit](completed/2026w45/engine-12-conformance-fixtures-host-kit.md) — all ten fixtures, schema-subset test, remaining threat-model tests, `docs/host-integration.md` for the Wriven implementer.
