# composition-07: `catch` steps and the composition worked example

**Spec:** [composition](../../../specs/composition.md#try) (`catch`, shape merging, permissions, worked example).

**To build:**
- **Non-empty `catch`.**
  - It receives each failed unit as the failing step saw it, with `meta.error_step`, `meta.error_code` and `meta.error_message` set.
  - Outputs from `steps` come first, then outputs from `catch`. The shape is the two merged (helper from composition-05).
  - A failure inside `catch` follows the normal rules.
- **Permissions.** `handles_failed_items`, its sentence, and its subset rule.
- **Worked example.** The spec's example runs end to end under `pipeline.test` and is added as a valid fixture with an embedded test.
- **Spec update.** [permissions](../../../specs/permissions.md): the new field and sentence.

**Blocked by:** [composition-05](completed/2026w45/composition-05-switch-shape-merging.md), [composition-06](completed/2026w45/composition-06-unit-failures-try.md). The worked example also needs [composition-01](completed/2026w45/composition-01-condition-filter.md) and [composition-04](completed/2026w45/composition-04-concurrent-host-llm.md).

**Verification:**
- **`catch` behaviour:**
  - with the 503 fixture, the output holds the two feeds' entries followed by one note message whose `meta.error_step` is `fetch` and whose `meta.source_url` is the failing URL;
  - permissions include "When an item fails at a step, handles it with fallback steps…".
- **Failures inside `catch`:**
  - a `catch` step that itself fails fails the run;
  - a `try` nested in `catch` handles it.
- **Worked example:**
  - green when entries plus failure notes reaching `classify_each` total at most 30;
  - with 31, it fails with `budget_exceeded` at the digest call;
  - its rendering matches the spec's description.

**Status:** done 2026-11-03

- [x] `catch` with error metadata and merged shape
- [x] `handles_failed_items` sentence and subset rule
- [x] Worked example fixture (`fixtures/pipelines/valid/composition-digest.json`) and embedded tests

The fixture keeps the spec's shape but filters on "alpha" and "beta", the words in the repository's feed fixtures, instead of "rust" and "zig". `catch` validates against the merge of the shapes the top-level steps of `steps` receive (recorded in the spec). Tests: `tests/catch.test.ts`.
