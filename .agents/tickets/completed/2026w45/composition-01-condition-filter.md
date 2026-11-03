# composition-01: the `condition` type and `filter`

**Spec:** [composition](../../../specs/composition.md#condition) (`condition`, `filter`), [pipeline-format](../../../specs/pipeline-format.md) (components, validation codes).

**To build:**
- **`condition`.** A shared JSON Schema and evaluator.
  - Leaf operators: `equals`, `in`, `contains`, `contains_any`, `starts_with`, `exists`, `gt`/`gte`/`lt`/`lte`, `newer_than`/`older_than`. String operators take `case: "insensitive"`.
  - Combinators `all`, `any`, `not`; at most 4 levels deep and 32 leaves.
  - Missing-field rule: a leaf on a missing field is false, except `exists: false`.
  - `newer_than`/`older_than` use the run's clock.
  - Validation against declared shapes: `unresolved_pointer` (except under `exists`) and `shape_mismatch`.
  - Run time: `condition_type_mismatch` when the shape is unknown and the type is wrong.
- **`filter`.** Uses `keep_if`, preserves ids, contributes no permission. A dropped message is a deliberate acknowledgement and is counted in `dropped`.
- **Registration.** `components.list` describes each operator and states the `not`-over-missing trap in one sentence.
- **Spec update.** [pipeline-format](../../../specs/pipeline-format.md) gains `filter` and the `condition` reference.

**Blocked by:** nothing; v0 is done.

**Verification:**
- **Unit tests**, one per operator: true, false and missing-field cases; `case: "insensitive"`; `newer_than` against a fake clock; depth 5 and 33 leaves rejected.
- **Spec acceptance criteria:**
  - the `contains_any` example keeps exactly "Rust 2.0" and reports `dropped: 2`;
  - `gt` on `/title` after `parse_feed` fails with `shape_mismatch` at the condition's path.
- **Feed example with a keyword `filter`:**
  - after `dedupe`, it runs green under `pipeline.test`;
  - its `permissions_hash` equals the hash without the `filter`.
- **Fixtures:** valid and invalid pipelines added under `fixtures/pipelines/`.

**Status:** done 2026-11-03

- [x] `condition` schema, evaluator, shape checks (`src/pipeline/condition.ts`)
- [x] `filter` component, schema, `components.list` text (a `condition` entry documents every operator)
- [x] Fixtures and tests (`tests/condition.test.ts`); pipeline-format updated

Recorded while building: a null field value counts as no value (only `equals: null`, `in` with null and `exists: true` hold), added to the spec, because feeds often have `published: null`.
