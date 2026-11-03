# composition-06: unit-level failures and `try` (no catch, empty catch)

**Spec:** [composition](../../../specs/composition.md#try) (`try`, permissions), [delivery-semantics](../../../specs/delivery-semantics.md#errors), [permissions](../../../specs/permissions.md). Grilling decisions 13 and 14.

**To build:**
- **Executor refactor.** Every processor reports failures per unit instead of throwing on the first one. The unit is one URL of one message for `http_fetch`, one input message for the others.
  - Outside a `try`, a unit failure fails the run exactly as today.
  - Uncatchable kinds still throw: host typed errors, `budget_exceeded`, `timed_out`, `memory_limit`, `cancelled`, `fixture_missing`, `internal`.
- **`try`.**
  - `steps` run on the batch. Failed units leave `steps`; the other units continue.
  - No `catch`: a failure fails the run.
  - `catch: []`: failed units are dropped deliberately, each with a warning carrying `caught_by`.
- **`on_error: skip`** on `http_fetch` and `parse_feed` is re-implemented as `try` with `catch: []` around that step. The rendering, the permission field and the warning shape stay byte-identical.
- **Permissions.** `skips_failed_items` (zero value excluded from the hash), its sentence, and the subset rule that it may go from true to false only.
- **Spec updates.**
  - [delivery-semantics](../../../specs/delivery-semantics.md) errors section: `try` replaces "there is no `catch` to route to", and `on_error: skip` is described as sugar.
  - [permissions](../../../specs/permissions.md): the new field.
  - [pipeline-format](../../../specs/pipeline-format.md): `try`.

**Blocked by:** [composition-03](completed/2026w45/composition-03-nested-steps-for-each.md).

**Verification:**
- **`try` around `http_fetch` (3 fixture URLs, one returning 503) and `parse_feed`:**
  - with `catch: []`, the run succeeds with the two feeds' entries and one warning `caught_by: "<try id>"`, and permissions include "Skips an item that fails at a step…";
  - without `catch`, the run fails with step `fetch`.
- **Uncatchable errors:** `quota_exhausted` at a `host_llm` inside `try` fails the run.
- **Regression:**
  - every existing `on_error: skip` test passes unchanged;
  - the v0 example's `permissions_hash` and rendering are byte-identical;
  - all ten protocol fixtures pass.

**Status:** done 2026-11-03

- [x] Per-unit failure reporting in all six v0 processors, and in `filter`, `split` and `switch` conditions (`ctx.unitFailed`)
- [x] `try` with no catch and empty catch; warnings with `caught_by`
- [x] `on_error: skip` as sugar, byte-identical behaviour (every v0 test unchanged and green)
- [x] `skips_failed_items`; specs updated (delivery-semantics, permissions, pipeline-format, host-protocol)

How it is built: a failure handler travels down the step tree. `ctx.unitFailed` throws when there is none or the error is uncatchable; a `try` with `catch` passes its own handler to its steps, a `try` without one passes the inherited handler, and `on_error: skip` swaps in a handler that warns as v0 did. Errors the host or supervisor returned at `host_llm` are marked internally so a `try` never catches them; the mark is stripped from reports. Each failed `http_fetch` unit gets its own copy of the message data. Tests: `tests/try.test.ts`.
