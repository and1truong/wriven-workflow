# composition-08: `while` and loop-aware idempotency keys

**Spec:** [composition](../../../specs/composition.md#while) (`while`, change 2), [delivery-semantics](../../../specs/delivery-semantics.md#idempotency-keys), [permissions](../../../specs/permissions.md) (`receives_fetched_content`). Grilling decisions 5 and 16.

**To build:**
- **`while`.**
  - `repeat_while`; `max_loops` required, 1–20; `at_least_once`; `on_limit: "fail" | "continue"`.
  - The condition is checked per message. Messages still in the loop go through `steps` together. A message dropped in the body leaves the loop and the batch.
  - Output in input order.
- **Validation.**
  - `changes_message_ids` when the body does not preserve ids (first use of the composition-03 property).
  - `sleep_exceeds_timeout` now multiplies each sleep by the `max_loops` of every enclosing `while`.
- **Idempotency key.** Inside a `while`, the `host.llm` key becomes `"<run_id>/<step_id>@<iterations>/<message_id>"`, with 1-based iterations of each enclosing loop, outermost first, joined by `.`. Outside loops it is unchanged.
- **Permissions.** An `http_fetch` anywhere in the same `while` body sets `receives_fetched_content`.
- **Spec updates.**
  - [delivery-semantics](../../../specs/delivery-semantics.md): the key table.
  - [permissions](../../../specs/permissions.md): the derivation rule.
  - [pipeline-format](../../../specs/pipeline-format.md): `while`, `changes_message_ids`.

**Blocked by:** [composition-01](completed/2026w45/composition-01-condition-filter.md), [composition-02](completed/2026w45/composition-02-split-log-sleep.md), [composition-03](completed/2026w45/composition-03-nested-steps-for-each.md).

**Verification:**
- **Loop limit:**
  - `max_loops: 3` around `host_llm` with replies that never satisfy the condition makes 3 calls with keys `…/<step>@1/<msg>`, `…@2/…` and `…@3/…`, then fails with `loop_limit`;
  - with `on_limit: "continue"`, it succeeds with one `loop_limit` warning per message.
- **Keys:**
  - nested loops produce keys like `@2.1`;
  - the fake host's lost-response case inside a loop repeats the same iteration key with `attempt: 2`.
- **Validation:**
  - `split` in the body fails with `changes_message_ids`;
  - `sleep: "5m"` in a loop with `max_loops: 3` and `run_timeout: "10m"` fails with `sleep_exceeds_timeout`.
- **Exit and regression:**
  - `at_least_once` runs the body once even when the condition starts false;
  - a `filter` in the body that drops a message removes it from the output;
  - v0 keys are unchanged.

**Status:** done 2026-11-03

- [x] `while` semantics and ordering
- [x] `changes_message_ids`; sleep bound with loops
- [x] Iteration-qualified idempotency keys (the run process sends `iteration`; the supervisor checks it against the enclosing loops and their `max_loops` before building the key)
- [x] Permission rule; specs updated (delivery-semantics, host-protocol, pipeline-format, permissions)

Notes:
- `loop_limit` is a unit failure, so a `try` around a `while` can recover from it; it is not in the uncatchable list.
- The "fetch in the same `while` body" permission rule cannot be reached through validation today: `http_fetch` makes new ids and a `while` body must keep them. It is kept and tested on the derivation directly, for a later component that fetches and keeps ids.
- `repeat_while` validates against the body's output shape with `at_least_once`, and against the merge of input and output shapes otherwise.

Tests: `tests/while.test.ts`. One full-suite run saw `tests/sandbox.test.ts` "past run_timeout" fail once (its 500 ms run timeout under load); the next two full runs and three standalone runs passed. Not changed here.
