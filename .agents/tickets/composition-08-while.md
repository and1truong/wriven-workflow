# composition-08: `while` and loop-aware idempotency keys

**Spec:** [composition](../specs/composition.md#while) (`while`, change 2), [delivery-semantics](../specs/delivery-semantics.md#idempotency-keys), [permissions](../specs/permissions.md) (`receives_fetched_content`). Grilling decisions 5 and 16.

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
  - [delivery-semantics](../specs/delivery-semantics.md): the key table.
  - [permissions](../specs/permissions.md): the derivation rule.
  - [pipeline-format](../specs/pipeline-format.md): `while`, `changes_message_ids`.

**Blocked by:** [composition-01](completed/2026w45/composition-01-condition-filter.md), [composition-02](composition-02-split-log-sleep.md), [composition-03](composition-03-nested-steps-for-each.md).

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

**Status:** open

- [ ] `while` semantics and ordering
- [ ] `changes_message_ids`; sleep bound with loops
- [ ] Iteration-qualified idempotency keys
- [ ] Permission rule; specs updated
