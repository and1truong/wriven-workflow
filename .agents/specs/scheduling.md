# Scheduling

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 1, 12), Wriven [scheduled-actions grilling](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W44/scheduled-actions.md) (decisions 5, 6, 12, 13), [ADR 002](../decisions/002-host-owns-keys-clock-history.md). Stage: **Design — spec**.

## Scope

Who owns the clock, the `schedule` input and its cron and time-zone semantics, the missed-run policy, daylight-saving behaviour, the interaction with pause and resume, and `schedule.preview`. Limits on how often a stream may run are in [pipeline-format](pipeline-format.md#limits).

## Observable behaviour

- With `clock: host` (Wriven's setting), the engine never starts a run by itself. The host decides when and calls `run.trigger`, optionally with `scheduled_for`. Pipelines using the `schedule` input are invalid for such a host. The host may still ask the engine for occurrence arithmetic via `schedule.preview`.
- With `clock: engine`, a stream whose input is `schedule` runs at each cron occurrence in its time zone while `active`. The engine persists the last handled occurrence per stream so a restart knows what was missed.
- A missed occurrence is handled according to the stream's declared `missed` policy, never by an engine-wide default the person cannot see. The permissions sentence states the policy.
- Pausing stops occurrences. Resuming does not catch up on what passed while paused.
- A run started for an occurrence records both `scheduled_for` (the occurrence) and `started_at` (the actual time), and the host displays both.

## Cron and time zones

- Syntax: five fields `minute hour day-of-month month day-of-week`, with `*`, lists `1,3`, ranges `1-5`, steps `*/15`, names `MON`–`SUN` and `JAN`–`DEC`. No seconds field, no `@daily` aliases (the agent writes `0 0 * * *`), no `L`/`W`/`#`. Day-of-month and day-of-week combine with OR when both are restricted, as in Vixie cron.
- `timezone` is a required IANA name (`Australia/Brisbane`), validated against the runtime's zone database. `UTC` is allowed. Abbreviations (`AEST`) are not.
- Occurrences are computed in local wall-clock time of that zone, then converted to instants. The engine's own clock is UTC; nothing depends on the machine's local zone.
- **Daylight saving.** A wall-clock time that does not exist on a transition day (02:30 when clocks jump 02:00→03:00) runs at the first valid instant after it (03:00). A wall-clock time that occurs twice (01:30 when clocks fall back) runs at the first occurrence only. These are the rules Hong accepted in decision 12; they match the Wriven scheduled-actions decision "giờ không tồn tại thì chạy ngay sau đó".
- Minimum interval between occurrences is one minute by syntax; `limits.runs_per_day` (max 48) is what actually bounds frequency. Validation rejects a cron whose occurrences per day exceed `runs_per_day` ("`*/5 * * * *` produces 288 runs per day; `runs_per_day` is 2").

## Missed-run policy

`missed` on the `schedule` input, one of:

| Value | When the engine notices occurrences passed while it was not running (or the machine slept) | Sentence |
| --- | --- | --- |
| `skip` | ignore them; wait for the next future occurrence | "Missed runs are skipped." |
| `run_once` (default) | run once, now, for the most recent missed occurrence (`scheduled_for` set to it); older ones are skipped | "If runs are missed, the most recent one is made up once." |
| `run_all` | run once per missed occurrence, oldest first, each with its own `scheduled_for`, subject to `runs_per_day` | "Every missed run is made up." |

"Missed" means: occurrence instant `t` with `last_handled < t ≤ now − grace`, where grace is 30 seconds so a run that was about to fire when the engine stopped is not counted twice. The engine updates `last_handled` to the occurrence instant when it enqueues the run, not when the run finishes; a run that fails is still "handled" (Wriven scheduled-actions decision 5: a failed run is not retried, the next occurrence is the retry).

Sleep: on macOS a timer does not fire while the machine sleeps; on wake the engine's loop sees `now` jump and applies the policy. The engine does not use `launchd` or power assertions; it is a child of the host and lives when the host lives.

With `clock: host`, all of this is the host's job, and the sentences come from the host's own policy (Wriven's chosen behaviour is "run once for the most recent missed occurrence when the app opens"). The engine renders "Runs: when Wriven asks." and, if the host passes `schedule_description` in `run.trigger` or `stream.create` metadata, appends it verbatim as the host's statement.

## Pause, resume, update, delete

- `stream.pause`: the scheduler drops the stream from its timer set. `last_handled` is frozen.
- `stream.resume`: `last_handled` is set to `now`, so nothing that passed while paused is made up. Next occurrence is computed from `now`. The response carries `next_run`.
- `stream.update` that changes `cron`, `timezone` or `missed` always re-approves ([permissions](permissions.md#pinning-and-comparison)); on approval `last_handled = now`. Any approval into `active` does this, since a stream waiting for approval could not run; what passed meanwhile is not made up.
- `stream.delete`: removed from the timer set; a running run of the stream is cancelled.
- Engine restart (host restarted): the scheduler reads every `active` manifest, applies the missed-run policy per stream against the persisted `last_handled`, and resumes timers.

## `schedule.preview`

`{ cron, timezone, after, count? (1–100, default 5) } → { occurrences: [RFC 3339 with offset] }`. Pure, side-effect free, usable before a pipeline exists. The host uses it to show "Next: Tue 4 Nov, 08:00" and to implement its own scheduler with identical arithmetic if it owns the clock.

## Decisions and reasons

1. **Clock ownership is a handshake fact, not a pipeline fact.** Wriven decided that scheduling, like keys and history, is the host's (sidecar decision 8: "Wriven vẫn gánh … lịch"). An engine-owned scheduler still exists because the project is independent and `fake-host` tests need it, but Wriven never turns it on.
2. **Declared missed policy, default `run_once`.** Matches Wriven's own decision 5 and makes the policy a sentence the person approves rather than a hidden constant.
3. **Cron, not a bespoke schedule object.** Agents know cron; the renderer turns the common forms into English; `schedule.preview` shows the agent what its cron means before it commits.
4. **No catch-up after resume.** The person who paused a digest for a week does not want seven digests on resume. Same as Wriven's "Resume hay sửa lịch không chạy bù".
5. **Occurrence-per-day check against `runs_per_day`.** Prevents an agent from writing an every-minute cron under a two-per-day limit and discovering it through `skipped` reports.

## Risks

- Time-zone database staleness: which zone data `Intl` uses depends on the runtime. The earlier note here said Bun embeds ICU in the binary; on macOS 27 with Bun 1.4.3 `Intl` failed once `/usr/share/icu` was denied by the sandbox (measured 2026-11-03), which suggests it reads system data, and zone rules would then follow the OS rather than the release. Whether that is the whole story is not verified. Either way zone arithmetic runs only in the engine process, never under the run sandbox.
- Wall-clock arithmetic has many edge cases; the test suite must be table-driven with transition days for at least `Australia/Sydney`, `Europe/London`, `America/New_York` and a zone without DST (`Australia/Brisbane`), plus `UTC`.

## Acceptance criteria

- `schedule.preview` for `0 8 * * 1-5` in `Australia/Brisbane` after `2026-11-06T09:00:00+10:00` returns Monday 2026-11-09T08:00:00+10:00 first.
- `30 2 * * *` in `Australia/Sydney` on the 2026 spring-forward day returns 03:00 local for that day; on the autumn fall-back day returns the first 02:30.
- A fake-clock test with `missed: run_once` and three occurrences skipped enqueues exactly one run with `scheduled_for` equal to the most recent occurrence; `run_all` enqueues three in order; `skip` enqueues none.
- Pausing across two occurrences and resuming enqueues nothing and reports `next_run` in the future.
- A pipeline with `*/5 * * * *` and `runs_per_day: 2` fails validation with a message naming 288.
- With `clock: host`, a pipeline with a `schedule` input fails validation with `schedule_requires_engine_clock`.

## Open points

- Whether `run_all` should be offered at all in v0 given `runs_per_day` already caps it. Kept because it is one word in a table and the sentence is clear; remove if no host wants it.
- Grace period of 30 seconds is a guess; measure against engine startup time once it exists.
