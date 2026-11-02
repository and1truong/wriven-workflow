# engine-03: First pipeline runs end to end against the fake host: `host_trigger → template → host_llm → host_result`

**Spec:** [architecture](../../../specs/architecture.md) (stream and run lifecycles, one run at a time), [delivery-semantics](../../../specs/delivery-semantics.md) (single ack, idempotency keys, cancellation), [host-protocol](../../../specs/host-protocol.md) (`stream.*`, `run.trigger`, `run.cancel`, `host.llm`, `host.result`, `run.started`/`run.finished`, run report). [ADR 006](../../../decisions/006-delivery-single-ack-strict-idempotent.md).

**To build:** Stream manifests under `state_dir/streams/<id>/`, `stream.create`/`approve`/`pause`/`resume`/`delete`/`list`/`get`, the run queue (depth 1, collapse per stream), `run.trigger` and `run.cancel`, the executor with batches and one ack per batch, the `host_llm` component forwarding `host.llm` with the idempotency key and counting against `llm_calls_per_run`, the `host_result` component, the run report, and `run.started`/`run.finished`. **The run executes in a child process (`--run`) over the private stdio protocol, but without a sandbox yet** (that is engine-04); the report says `sandbox: "none"`. `fake-host` answers `host.llm` with an echo or scripted responses and can drop a response on command.

**Blocked by:** [engine-02](engine-02-format-validate-components.md).

**Verification:** Conformance fixtures 3 (success), 4 (`quota_exhausted` → `failed`, no result), 5 (lost `host.llm` response → repeated key, `attempt: 2`, one provider call in the fake host log), 7 (cancel during `host.llm` → `$/cancel`, `cancelled`), 8 (stdin EOF during a run → `run.finished` cancelled, exit 0). `run.trigger` on `pending_approval` → `permission_denied`; on `paused` → `conflict`; two triggers during a run → one extra run. Killing the run process externally → `failed` with `process_exited`, engine keeps serving. `llm_calls_per_run: 1` with two `host_llm` steps → `budget_exceeded` at the second, one call seen by the fake host. Report validates against the report schema.

**Status:** done 2026-11-03

- [x] Manifests, stream methods, status machine
- [x] Run queue, `run.trigger`, `run.cancel`, collapse
- [x] `--run` child, private protocol, report
- [x] `host_llm` with idempotency key and cap; `host_result` with key
- [x] Fixtures 3, 4, 5, 7, 8
