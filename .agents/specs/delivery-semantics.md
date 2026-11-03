# Delivery semantics: acknowledgements, batching, errors, cancellation, shutdown

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 6, 13), [ADR 006](../decisions/006-delivery-single-ack-strict-idempotent.md), [Benthos research](../research/research-benthos.md) (read 2026-11-03). Stage: **Design — spec**.

## Scope

What the engine promises about each message inside a run, what a run promises to the host, how fan-out and batching interact with acknowledgements, what happens on error, and how cancellation and shutdown behave. The wire format of `host.llm` and `host.result` is in [host-protocol](host-protocol.md).

## The guarantee, stated once

Within a run: **every message read from the input is either delivered to the output and acknowledged, or deliberately dropped and acknowledged, or the run fails.** Delivery to `host_result` is at-least-once at the transport level and exactly-once as seen by the host, because every `host.result` and `host.llm` request carries an idempotency key the host must honour.

Across runs: **a failed run is not retried, and nothing a failed run did is remembered.** Operational state (dedupe keys) is committed only when a run succeeds, so the next run sees the same items again. Cost already spent in the failed run is spent; the run report says how much.

Nothing in v0 buffers messages in a way that acknowledges before delivery. There is no memory buffer component.

## Model

Borrowed from Redpanda Connect's transaction model ([research](../research/research-benthos.md) §1): the input produces a **batch with one acknowledgement function**. Processors may split a batch into more messages (`parse_feed`), drop messages (`dedupe`), or merge a batch into one message (`collect`), but every descendant still maps back to the single ack of the batch it came from. The output acknowledges a batch when all its messages are written. The input's ack is called once, when every batch derived from the input batch has been acknowledged or dropped.

In v0 every input emits exactly one batch per run (one trigger message), so "the input batch is acked" and "the run succeeded" are the same event. The model is still stated per batch so that a future input that emits many batches (a file watcher, a queue) does not change the rules.

```
input batch B0 (1 msg)  ──http_fetch──►  B0' (3 msgs)  ──parse_feed──►  B0'' (41 msgs)
  ──dedupe──►  B0''' (5 msgs)  ──collect──►  B0'''' (1 msg)  ──template──►  ──host_llm──►  ──host_result──► ack(B0)
```

Every arrow preserves the mapping to `B0`. There is exactly one `ack(B0)`.

## Backpressure

A run process holds at most one batch in flight between any two processors: a processor does not start on batch N+1 until batch N has left it. With one batch per run in v0 this is moot, but the executor is written this way so that an input emitting many batches is throttled by the slowest stage rather than queueing in memory. `http_fetch` performs its URL fetches with a concurrency of 4; `host.llm` requests of one run are outstanding at most `llm_concurrency` at a time, a number the host declares at `initialize` (default 1, so a host that does not declare it never sees two concurrent calls from one run). Only `for_each` with `concurrency` and `workflow` branches can overlap calls ([composition](composition.md#for_each)). Each call is counted against the limit before it waits for a slot.

## Errors

**Processor errors are terminal by default.** A processor that fails on a message fails the run with a typed error that names the processor `id`, the message `id` and the cause. This is the opposite of Benthos's default (flag and continue) and the same as Redpanda Connect's opt-in `error_handling.strict` ([research](../research/research-benthos.md) §1). Reason: the person is not watching, and a half-processed digest delivered as if whole is worse than a visible failure. Recovery is something the agent writes on purpose with a `try` ([composition](composition.md#try)): a unit (one URL of `http_fetch`, one message elsewhere) that fails inside its `steps` leaves them, is reported as a warning with `caught_by`, and is dropped (`catch: []`) or handed to `catch`. Host errors, limits, timeouts, cancellation and `fixture_missing` are never caught.

**`on_error: skip`**, available on `http_fetch` and `parse_feed`, is a `try` with `catch: []` around that one step, kept for format `@1` and reported exactly as v0 did (a warning without `caught_by`). With it, the failing message is dropped (acknowledged as deliberate), a warning `{ "step": id, "message_id", "code", "message" }` is appended to the run report, and the run continues. If skipping leaves a batch empty, downstream components see an empty batch; `collect` with `min_items: 1` then drops it and the run succeeds with a report that says "nothing to summarize" and lists the warnings. The permissions rendering includes "Skips a source that cannot be fetched or read that day." so the person knows silence can mean "all three feeds failed".

With `on_error: skip`, a host outside the allowlist on a redirect is skipped like any other failure, and the attempted host stays in `network.denied` in the report. Cancellation is never skipped.

**`host_llm` errors are never skipped and never retried by the engine.** The host's typed error (credentials, quota, rate limit, provider unavailable, budget) becomes the run's error. If the host says `retry_after`, the report carries it so the host can show "try again after 14:00"; the engine does not act on it.

**Output errors fail the run** unless the output has `retry` configured (only `host_result` has it in v0, and only because the host may be momentarily busy writing: `retry: { "max_attempts": 3, "backoff": "2s" }`). With retry, the same message is re-sent with the same idempotency key, so the host deduplicates.

**Limits** are errors with their own codes: `budget_exceeded` (`llm_calls_per_run` or `llm_cost_per_run_usd`), `timed_out`, `memory_limit`, `runs_per_day_exceeded` (reported as status `skipped`, since the run never started).

## Idempotency keys

| Request | Key | Host must |
| --- | --- | --- |
| `host.llm` | `"<run_id>/<step_id>/<message_id>"` | Return the stored reply for a repeated key within the run's lifetime instead of calling the provider again. The engine only repeats a key after a transport failure between engine and host (lost response); it never repeats a key for a different prompt. |
| `host.result` | `"<run_id>/<message_id>"` | Not create a second result for a repeated key. |

Keys are also present in the run report, so the host can reconcile what it stored with what the engine thinks happened.

Why this matters: a `host.llm` whose reply was lost on the way back is indistinguishable from one that never ran. Without the key, the only safe choice would be to fail the run and waste the call; with it, the host answers from its own record.

## State and acknowledgements

`dedupe` keeps a set of seen keys per stream. During a run it works against an in-memory copy. When the run reaches `succeeded`, the run process writes `state.json.tmp` and renames it over `state.json` before sending the final report. A run that fails, times out or is cancelled writes nothing. Consequence: a run that fetched 5 new items, called the model, and then failed to deliver the result will see the same 5 items next time and call the model again. This is the documented at-least-once cost; it is bounded by `runs_per_day`.

The alternative (commit as soon as `dedupe` sees a key) is the trap the Redpanda Connect docs warn about: a retry turns into a drop ([research](../research/research-benthos.md) §6). Rejected.

## Fan-out

v0 has one output and no `broker`. `http_fetch` is the only fan-out, and it is a fan-out of *fetches*, not of deliveries: each URL becomes a message in the same batch, so a failing URL is a processor error (strict) or a skip (`on_error: skip`), never a partially acknowledged batch. If a multi-output broker arrives later, it must follow the Redpanda Connect `fan_out` rule: retry the failing child in place and keep the input ack waiting, never nack the input while other children already have the message ([research](../research/research-benthos.md) §2, lesson 4).

## Batching

v0 has no batching policy knobs. `collect` is the only component that changes batch shape deliberately, and it never splits. If a batching policy is added, it uses the Redpanda Connect vocabulary `{ count, byte_size, period }`, flushes on any condition, and flushes pending batches on shutdown ([research](../research/research-benthos.md) §4).

## Cancellation and shutdown

Three triggers: `run.cancel` from the host, `shutdown` from the host, and the engine's stdin closing (host gone).

| Trigger | Engine does | Run process does | Host sees |
| --- | --- | --- | --- |
| `run.cancel { run_id }` | forwards cancel to the run process; sends `$/cancel { id }` for any outstanding `host.llm` request of that run | aborts in-flight HTTP via `AbortController`; stops reading input; sends its report within 5 s | `run.finished` with status `cancelled`, `cancelled_at_step` |
| `shutdown { timeout? }` | stops accepting triggers; cancels queued runs as `cancelled` (reason `shutdown`); gives the running run the smaller of its remaining `run_timeout` and the shutdown timeout (default 10 s) to finish; then kills it | as above when cancelled, otherwise finishes normally | `run.finished` for each affected run, then the `shutdown` response, then exit code 0 |
| stdin EOF | same as `shutdown` with the default timeout, but there is nobody to answer; the engine still writes `run.finished` to stdout in case the host is reading | same | exit code 0 |

After the deadline the engine sends `SIGKILL` to the run process group (the sandbox wrapper and the run process are one group). A killed run reports `cancelled` with reason `killed_after_timeout` if any report can still be assembled, otherwise the engine synthesizes a report with what it knows (run id, stream, start time, last step heard from).

A cancelled run commits no state and is not retried. The host decides whether to show it as "Interrupted", in its own words.

## Decisions and reasons

1. **Strict errors by default.** Unsupervised runs need a clear failed/succeeded, and the agent has no `catch` to write. Skipping is per component and visible.
2. **Idempotency keys on both host-facing requests.** The only way to make "at-least-once transport" and "never pay twice" both true. The host side is small: a map from key to stored reply/result for the run's lifetime.
3. **Commit state on success only.** Correctness over cost, with the cost bounded by `runs_per_day`.
4. **No cross-run redelivery.** A failed run stays failed (Wriven scheduled-actions decision 5: "Lần hỏng không chạy lại, đợi mốc kế tiếp"). The next scheduled occurrence is the retry, and the person sees both.
5. **No `succeeded_empty` status; an optional `nothing_new: true` on `succeeded` instead.** Decided in engine-06. A host needs to say "nothing new today" without parsing warnings, but a run that found nothing did succeed, and every host switch over `status` would otherwise need another case for what is the same outcome. `nothing_new` is set when the run succeeded, delivered no result and has no warnings, so "all three feeds failed and were skipped" does not read as "nothing new": there the host sees the warnings instead.
6. **At most `llm_concurrency` outstanding `host.llm` calls per run, default 1.** Revised by composition grilling decision 15 (2026-11-03); the original was "sequential calls per run", which made the cap check trivial and the host's load predictable. Both still hold: the count is reserved before a call waits for a slot, and a host gets concurrency only when it asks for it.

## Risks

- A host that does not implement idempotency keys will create duplicate results or pay twice on a lost response. The host conformance fixtures (ticket 12) include a lost-response case so this is caught before integration.
- Strict errors make flaky feeds visible as failures until the agent adds `on_error: skip`. That is intended, but the agent surface should suggest it in the error message.

## Acceptance criteria

- A test pipeline `inject → template → host_llm → host_result` with the fake host configured to drop the first `host.llm` response yields exactly one provider call in the fake host's log and one result, and the report shows one `host.llm` request with `attempt: 2`.
- With `on_error: skip` on `http_fetch` and one of three URLs returning 503 from the fixture server, the run succeeds, the report has one warning naming the URL, and the result covers the two other feeds.
- Without `on_error`, the same scenario fails with `step: "fetch"` and the 503 in the message, and `state.json` is unchanged.
- A run cancelled during `host_llm` sends `$/cancel` with the matching request id, finishes with `cancelled`, and leaves `state.json` unchanged.
- Closing the engine's stdin during a run yields `run.finished` with `cancelled` on stdout and exit code 0 within the shutdown timeout plus 1 second.
- A `host_result` with `retry` and a fake host that fails the first write produces exactly one result with the same idempotency key in both attempts.
