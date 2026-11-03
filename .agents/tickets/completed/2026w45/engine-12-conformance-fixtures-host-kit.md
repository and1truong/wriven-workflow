# engine-12: Complete conformance fixtures and a host integration kit

**Spec:** [host-protocol](../../../specs/host-protocol.md#conformance-fixtures), [agent-surface](../../../specs/agent-surface.md) (tool encodings per provider), [threat-model](../../../specs/threat-model.md#acceptance-criteria).

**To build:** All ten protocol fixtures under `fixtures/protocol/` with placeholders documented; `fake-host --conformance` replays them and reports pass/fail per scenario; a `docs/host-integration.md` written for the Wriven implementer: spawn, handshake, tool forwarding with the three provider encodings and the Gemini `thoughtSignature`/OpenRouter `tool_calls` echo requirements, `host.llm` idempotency and per-run counting, `host.result` with the report's timestamps, approval UI inputs, error-kind mapping to Wriven's existing error types, state directory requirements, `doctor` and `--version` checks. The schema-subset test for all eleven tools across three provider encodings. The threat-model acceptance tests that are not already covered by earlier tickets (prompt-injection fixture producing only text; proxy 407 without token; host exit leaves no processes).

**Blocked by:** [engine-10](engine-10-limits-runs-per-day-cost.md), [engine-09](engine-09-scheduler-engine-clock.md), [engine-07](engine-07-approval-update-diff.md), [engine-08](engine-08-pipeline-test-harness-inject.md).

**Verification:** `fake-host --conformance fixtures/protocol` reports 10/10 against the release binary. The schema-subset test passes. The three threat-model tests pass. `docs/host-integration.md` is reviewed by Hong against the Wriven inbox's list of preconditions and every precondition has a section.

**Status:** done 2026-11-03; Hong reviewed `docs/host-integration.md` and closed it

- [x] Fixtures 1–10 complete and documented
- [x] Schema-subset test, three encodings
- [x] Remaining threat-model tests
- [x] `docs/host-integration.md`
- [x] Hong reviews `docs/host-integration.md` against the Wriven inbox's preconditions
