# ADR 006: Delivery — one acknowledgement per batch, strict processor errors, idempotent host calls, no cross-run redelivery

Date: 2026-11-03. Status: accepted (Hong, grilling decisions 6 and 13).

## Context

Benthos/Redpanda Connect/Bento achieve at-least-once without persistence by tying one `ack(err)` to each input batch and calling it only when every output has acknowledged; processor errors are a per-message flag with `try`/`catch`/`reject` as control flow; fan-out variants that nack the input while other outputs already have the message produce "unlimited duplicates" ([research](../research/research-benthos.md), read 2026-11-03). Wriven's sidecar grilling noted that redelivering an LLM step "nghĩa là trả tiền hai lần", and its scheduled-actions grilling decided a failed run waits for the next occurrence rather than retrying.

## Decision

- Within a run: one acknowledgement per input batch; every descendant message maps back to it; a batch is acknowledged when all derived messages are delivered or deliberately dropped. Backpressure is one batch in flight per stage.
- Processor errors are terminal for the run (strict), with one declarative relaxation, `on_error: skip`, on `http_fetch` and `parse_feed`, which drops the message and records a warning.
- `host.llm` and `host.result` carry idempotency keys (`run_id/step_id/message_id`, `run_id/message_id`) the host must honour. The engine never retries `host.llm`; it repeats a key only after a lost response. `host_result` may retry with the same key if configured.
- Operational state (dedupe keys) is committed only when a run succeeds.
- A failed, timed-out or cancelled run is never retried by the engine; the next occurrence is the retry, and both are visible to the person.
- No buffer component that acknowledges before delivery.

## Consequences

- "Never pay twice" and "never lose a delivery" are both true, with the duplicate-avoidance work placed where the knowledge is: the host, which is the only party that knows whether a provider call completed.
- A failed run can cost model calls and produce nothing; the report shows the spend; `runs_per_day` bounds repetition.
- Strict errors make flaky sources visible; agents must opt into skipping, and the person sees the sentence for it.
- Future multi-output fan-out must retry a failing child in place (Redpanda Connect `fan_out`), never nack the input while siblings have the message.
- Hosts that skip the idempotency contract will see duplicates or double spend; the conformance fixtures include the lost-response case to catch this before integration.
