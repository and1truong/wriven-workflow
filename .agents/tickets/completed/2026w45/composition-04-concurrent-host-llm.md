# composition-04: concurrent `host.llm` through `llm_concurrency`

**Spec:** [composition](../../../specs/composition.md#for_each) (`for_each` concurrency, test harness, changes 2 and 3), [host-protocol](../../../specs/host-protocol.md) (`initialize`, conformance), [delivery-semantics](../../../specs/delivery-semantics.md) (decision 6). Grilling decision 15.

**To build:**
- **Host capability.** `initialize` accepts an optional `llm_concurrency` (integer 1–8, default 1). A host that sends nothing keeps the one-call-at-a-time guarantee.
- **Engine.**
  - Up to `min(for_each.concurrency, llm_concurrency)` outstanding `host.llm` requests per run.
  - The `llm_calls_per_run` slot is reserved before each send, so concurrent calls cannot overshoot.
  - The first failure aborts in-flight siblings: abort the HTTP fetches and send `$/cancel` for the outstanding `host.llm` requests.
  - Outputs in input order.
- **Fake host.** Answers concurrently with configurable latency and records the peak number of outstanding calls.
- **Test harness.** Under `pipeline.test` every `concurrency` is clamped to 1 and listed in `clamped`.
- **Conformance kit.** A new case with two concurrent calls.
- **Spec updates.**
  - [host-protocol](../../../specs/host-protocol.md): `llm_concurrency`, the new conformance case.
  - [delivery-semantics](../../../specs/delivery-semantics.md) decision 6 becomes "at most `llm_concurrency` outstanding requests".
  - [agent-surface](../../../specs/agent-surface.md): `clamped`.
  - `docs/host-integration.md`: one paragraph on the capability.

**Blocked by:** [composition-03](completed/2026w45/composition-03-nested-steps-for-each.md).

**Verification:**
- **Concurrency against the fake host** (`llm_concurrency: 4`, `for_each` with `concurrency: 4` over 8 messages):
  - peak outstanding is 4, there are exactly 8 calls, and outputs are in input order;
  - with `llm_calls_per_run: 5`, the run fails with `budget_exceeded` after exactly 5 sends.
- **Capability absent:** with no `llm_concurrency` from the host, peak outstanding is 1.
- **Failure:** message 3 failing aborts the others and sends `$/cancel` for each outstanding request.
- **Test harness:** the same pipeline under `pipeline.test` reports `clamped: ["for_each:<id>"]` and gives mock replies in input order.
- **Conformance kit:** passes, including the new case.

**Status:** done 2026-11-03

- [x] `initialize` capability and ceiling
- [x] Concurrent dispatch with reserved budget, abort on failure (a semaphore in the supervisor, so a run process cannot exceed what the host granted)
- [x] Fake host concurrency (`latency_ms`, `peakLlm`); conformance case **moved to [composition-09](composition-09-workflow.md)**
- [x] Harness clamp; specs and host-integration doc updated

Deviations, recorded here:
- **Conformance case moved to composition-09.** A conformance scenario drives a real stream with no network and no `inject`, and with only `host_trigger` it cannot produce two messages to overlap. Two `workflow` branches can, so the case lands with `workflow`.
- **"Message 3 failing" is tested as a budget failure.** With the host holding every call and `llm_calls_per_run: 2`, the third call fails the run while two are outstanding, and both get `$/cancel`. A per-message failure timed after siblings' calls is racy to arrange; the budget case exercises the same path deterministically.
- The fake host now records a call as received before its latency elapses and does not answer a call cancelled during it.

Tests: `tests/concurrency.test.ts`.
