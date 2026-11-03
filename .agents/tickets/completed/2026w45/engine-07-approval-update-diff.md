# engine-07: Approval pinning, subset rule on update, diff, rollback to previous

**Spec:** [permissions](../../../specs/permissions.md#pinning-and-comparison), [host-protocol](../../../specs/host-protocol.md) (`stream.approve`, `stream.update`, `stream.get`), [architecture](../../../specs/architecture.md#stream-lifecycle), [threat-model](../../../specs/threat-model.md) (T5, T6). [ADR 005](../../../decisions/005-permissions-derived-and-pinned.md).

**To build:** `stream.approve` with exact-hash check; `stream.update` with the field-by-field subset rule from the spec, immediate apply on subset, `pending_approval` with `diff.added/removed` sentences otherwise, `manifest.previous.json` retained, previous pipeline no longer runnable until approved or rolled back; `stream.get` returns `previous_pipeline`; `stream.changed` notification. Hash stability rules (zero values excluded from canonical form).

**Blocked by:** [engine-06](engine-06-parse-feed-dedupe-collect.md) (needs all components for a meaningful subset test).

**Verification:** Fixture 6 (narrowing update applies; widening update → `pending_approval` with diff). Adding a host → diff shows old and new "Fetches from" lines; removing one → applied silently. `cron` change → `pending_approval`. `stale hash` on approve → `conflict`. Rolling back by `stream.update` with `previous_pipeline` → applied without approval. A `run.trigger` while `pending_approval` after a widening update → `permission_denied`. Adding a new zero-valued field to the permissions object in a test build does not change existing hashes.

**Status:** done 2026-11-03

- [x] Approve with hash check
- [x] Subset comparison per field; diff rendering
- [x] Previous manifest, rollback path, `stream.changed`
- [x] Fixture 6
