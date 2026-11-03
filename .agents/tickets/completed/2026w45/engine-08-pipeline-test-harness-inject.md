# engine-08: `pipeline.test` harness: injected input, mocked LLM, fixtures, fake clock, embedded tests

**Spec:** [agent-surface](../../../specs/agent-surface.md#pipeline-tests), [pipeline-format](../../../specs/pipeline-format.md) (`inject`, `tests`), [host-protocol](../../../specs/host-protocol.md) (`pipeline.test`, `live_network_in_tests`).

**To build:** `pipeline.test` runs the pipeline once in a sandboxed run process with: `input` override, `llm` modes `mock` and `echo`, `fixtures` served by the in-process fixture server behind the proxy, `network: mock|live` gated by the host capability, `clock`. Returns a report with `trigger: "test"`, `results[]`, `llm_requests[]`. Never writes state, never calls the real host for `host.llm`/`host.result`. Embedded `tests[]` with the small `expect` vocabulary; `wriven-workflow test <file>` CLI; `run_embedded`.

**Blocked by:** [engine-06](engine-06-parse-feed-dedupe-collect.md).

**Verification:** The example pipeline with three fixtures and `llm.mode: mock` → `succeeded`, one result equal to the mock, `llm_requests[0].prompt` contains fixture titles, no `state.json` afterwards. `network: live` against a host without the capability → `permission_denied`. Missing fixture under `mock` → `fixture_missing`. Embedded test expecting `error_kind: fixture_missing` passes when a fixture is omitted. `clock` set past `remember` re-admits keys. `wriven-workflow test fixtures/pipelines/valid/feed-digest.json` exits 0.

**Status:** done 2026-11-03

- [x] Harness in the run process; `inject`; input override
- [x] Mock and echo LLM; fixtures server; `network` gate
- [x] Fake clock; no state writes
- [x] Embedded tests, `expect` vocabulary, CLI `test`
