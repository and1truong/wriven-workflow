# engine-02: Pipeline format, JSON Schema, `pipeline.validate`, permissions derivation skeleton

**Spec:** [pipeline-format](../specs/pipeline-format.md), [permissions](../specs/permissions.md) (object, canonical form, hash, sentence templates), [ADR 003](../decisions/003-no-expression-language.md), [ADR 005](../decisions/005-permissions-derived-and-pinned.md), [ADR 007](../decisions/007-json-canonical-format.md), [ADR 008](../decisions/008-mandatory-limits.md).

**To build:** The pipeline document model for `wriven-workflow/pipeline@1`, its published JSON Schema, the component registry with schemas and declared output shapes, JSON Pointer resolution against shapes, `limits` validation with compiled-in ceilings and host ceilings from `initialize`, and `pipeline.validate` returning errors with paths and codes. Three components registered: `host_trigger`, `template`, `host_result` (plus `inject` and `drop` for tests). Permissions derivation and English rendering for those components, canonical JSON and SHA-256 hash. `components.list` returns the registry and the schema.

**Blocked by:** [engine-01](engine-01-serve-handshake-fake-host.md).

**Verification:** `fixtures/pipelines/valid/*.json` all validate; `fixtures/pipelines/invalid/*.json` each fail with the expected code (`unknown_field`, `missing_limits`, `limit_out_of_range`, `unresolved_pointer`, `shape_mismatch`, `input_not_allowed`). Hash unchanged under key reordering and whitespace. A `host_trigger → template → host_result` pipeline renders exactly: "Runs: when Wriven asks." / "Fetches from: nowhere." / "Writes results to: Wriven." / "Limits: …" / "Does not: …" / "OS sandbox: …". Conformance fixture 2 (validate valid and three invalid) passes. Validation makes no network or filesystem call (asserted by a test that runs it with a sandboxed harness).

**Status:** not started

- [ ] Document model, schema, strict unknown fields
- [ ] Component registry with output shapes; pointer validation
- [ ] Limits and ceilings
- [ ] Permissions object, canonical form, hash, sentences for the five components
- [ ] `pipeline.validate`, `components.list`, fixture 2
