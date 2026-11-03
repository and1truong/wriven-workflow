# composition-04: concurrent `host.llm` through `llm_concurrency`

**Spec:** [composition](../specs/composition.md#for_each) (`for_each` concurrency, test harness, changes 2 and 3), [host-protocol](../specs/host-protocol.md) (`initialize`, conformance), [delivery-semantics](../specs/delivery-semantics.md) (decision 6). Grilling decision 15.

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
  - [host-protocol](../specs/host-protocol.md): `llm_concurrency`, the new conformance case.
  - [delivery-semantics](../specs/delivery-semantics.md) decision 6 becomes "at most `llm_concurrency` outstanding requests".
  - [agent-surface](../specs/agent-surface.md): `clamped`.
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

**Status:** open

- [ ] `initialize` capability and ceiling
- [ ] Concurrent dispatch with reserved budget, abort on failure
- [ ] Fake host concurrency; conformance case
- [ ] Harness clamp; specs and host-integration doc updated
