# composition-02: leaf components `split`, `log`, `sleep`

**Spec:** [composition](../../../specs/composition.md#split) (`split`, `log`, `sleep`, run report, test harness), [agent-surface](../../../specs/agent-surface.md#pipeline-tests).

**To build:**
- **`split`.**
  - `field` must be an array. Ids are `<id>.<n>`, the `parse_feed` scheme. `meta` is copied.
  - An empty array drops the message, deliberately.
  - A non-array is a processor error.
  - `max_items` defaults to 100, at most 1,000; extra elements are dropped with a warning.
  - Declares that it does not preserve ids. Its output shape is the array's item shape.
- **`log`.**
  - `text` is at most 500 characters, with `template` placeholders and `missing: "empty"` always on.
  - Appends `{ step, message_id, text }` to a new report field `logs[]`.
  - 100 entries per run, then one `logs_truncated` warning.
  - `pipeline.test` returns `logs`. Embedded tests gain `expect.logs_contain`.
- **`sleep`.**
  - `duration` from 1s to 5m; waits once per batch; interrupted by cancel.
  - Under `pipeline.test` it advances the fake clock instead of waiting.
  - Validation `sleep_exceeds_timeout`: the sum of sleeps along the top-level path must be below `run_timeout`. Loops multiply this sum later, in composition-08.
- **Spec updates.**
  - Report schema: `logs`.
  - [agent-surface](../../../specs/agent-surface.md): `logs`, `logs_contain`.
  - [pipeline-format](../../../specs/pipeline-format.md): the three components and `sleep_exceeds_timeout`.
- None of the three contributes a permission.

**Blocked by:** nothing; can run in parallel with composition-01.

**Verification:**
- **`split`:**
  - over `[{a:1},{a:2}]`, it yields two messages `m1.0`, `m1.1` with `data` `{a:1}` and `{a:2}`;
  - `[]` drops the message and the run succeeds;
  - a string gives a processor error naming the step;
  - 1,500 elements with `max_items: 1000` give 1,000 messages and one warning.
- **`log`:**
  - with an unresolvable placeholder, it never fails;
  - 150 messages give 100 entries and one `logs_truncated`;
  - `logs_contain` passes and fails as expected in an embedded test.
- **`sleep`:**
  - `sleep: "1m"` under `pipeline.test` finishes in under a second of wall time and moves the fake clock by 60 s;
  - two sleeps of 3m with `run_timeout: "5m"` fail validation with `sleep_exceeds_timeout`;
  - `run.cancel` during a real sleep finishes `cancelled` within 1 s.
- **Regression:** v0 example hashes are unchanged.

**Status:** done 2026-11-03

- [x] `split`
- [x] `log`, report `logs`, harness `logs` and `logs_contain`
- [x] `sleep`, fake-clock advance, `sleep_exceeds_timeout`
- [x] Specs updated (report in host-protocol, agent-surface, pipeline-format)

Tests: `tests/leaf-components.test.ts`. The report's `logs` field is present only when a run logged something, so v0 reports are unchanged.
