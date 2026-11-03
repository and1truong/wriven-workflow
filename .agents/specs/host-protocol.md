# Host protocol: the integration contract

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 1, 6, 8, 13, 14), [ADR 002](../decisions/002-host-owns-keys-clock-history.md), [ADR 006](../decisions/006-delivery-single-ack-strict-idempotent.md). Stage: **Design — spec**. This is the document the Wriven side builds against; it must be precise enough to implement a host without reading the engine's code.

## Scope

Transport and framing, the handshake, every method in both directions, the typed error vocabulary, the run report, versioning rules, and the conformance fixtures a host can test against. Tool definitions for the model are in [agent-surface](agent-surface.md); they map 1:1 onto host → engine methods listed here.

## Transport

- The host spawns `wriven-workflow serve` with stdin and stdout as pipes and stderr inherited or captured for logs. No arguments carry configuration; everything comes in `initialize`.
- **JSON-RPC 2.0**, one message per line, UTF-8, `\n` terminated, no `Content-Length` header. A line is at most 4 MiB; a larger message is an error `-32600` and the connection is otherwise unaffected.
- Both sides may send requests and notifications at any time after `initialize` completes. Responses may arrive out of order; correlate by `id`. Ids are strings or integers; the engine uses strings of the form `e-<n>`, hosts should use their own prefix.
- Cancellation uses the LSP convention: notification `$/cancel` with `{ "id": <request id> }`. The cancelled request still gets a response, with error `cancelled`.
- The engine writes nothing to stdout except protocol messages. Human-readable logs go to stderr as single-line JSON `{ "level", "time", "msg", ... }`.
- The engine treats stdin EOF as `shutdown` with the default timeout and exits 0 after draining.

## Handshake

The host sends `initialize` first; the engine answers nothing else until then (a request before `initialize` gets error `not_initialized`).

**Request `initialize`** (host → engine):

```json
{
  "protocol_version": 1,
  "host": { "name": "wriven-desktop", "version": "0.14.0", "display_name": "Wriven" },
  "clock": "host",
  "state_dir": "/Users/me/Library/Application Support/Wriven/workflow",
  "sandbox": "required",
  "capabilities": { "llm": true, "llm_reports_cost": false, "results": true, "live_network_in_tests": false },
  "ceilings": { "llm_calls_per_run": 10, "runs_per_day": 24, "run_timeout": "10m", "run_memory_mb": 512 },
  "timeouts": { "host_response": "120s" }
}
```

| Field | Meaning |
| --- | --- |
| `protocol_version` | The one version the host speaks. The engine answers with the same number or fails with `unsupported_version` listing what it supports. No negotiation beyond that. |
| `host.display_name` | Used in permission sentences ("Writes results to: Wriven."). |
| `clock` | `host`: the engine never fires runs on its own; pipelines with a `schedule` input are invalid. `engine`: the engine runs its scheduler. See [scheduling](scheduling.md). |
| `state_dir` | Must exist, be a directory, be owned by the current user, and have mode `0700`. The engine refuses otherwise (`invalid_state_dir`). It creates `streams/` and `engine.lock` inside. |
| `sandbox` | `required` (default): no run without OS sandbox. `optional`: runs proceed without it, reports say so, sentences say so. |
| `capabilities.llm` | Whether the host serves `host.llm`. If false, pipelines containing `host_llm` are invalid for this host. |
| `capabilities.llm_reports_cost` | Whether `host.llm` responses include `usage.cost_usd`. Affects the cost-limit sentence. |
| `capabilities.results` | Whether the host serves `host.result`. |
| `capabilities.live_network_in_tests` | Whether `pipeline.test` may use `network: "live"`. |
| `ceilings` | Optional. Each lowers the engine's compiled-in ceiling; a value above the compiled one is `invalid_params`. |
| `timeouts.host_response` | Optional, default `120s`. How long the engine waits for an answer to `host.llm` or `host.result` before it treats the response as lost and repeats the same `idempotency_key` with `attempt: 2`. After a second silence the run fails with `host_error`, reason `no_response`. A slow provider call is therefore repeated too, so a host must answer a key it is still working on by waiting for that same call, not by starting a second one. |

**Response**:

```json
{
  "protocol_version": 1,
  "engine": { "name": "wriven-workflow", "version": "0.1.0" },
  "pipeline_formats": ["wriven-workflow/pipeline@1"],
  "report_version": 1,
  "sandbox": { "available": true, "mechanism": "seatbelt" },
  "ceilings": { "llm_calls_per_run": 10, "runs_per_day": 24, "run_timeout": "10m", "run_memory_mb": 512 },
  "components": [ { "type": "http_fetch", "kind": "processor", "schema": { ... }, "summary": "Fetch pages over HTTPS from listed hosts." }, ... ],
  "tools": [ { "name": "workflow_validate_pipeline", "description": "...", "input_schema": { ... }, "method": "pipeline.validate" }, ... ],
  "streams": [ { "stream_id": "...", "name": "...", "status": "active", "permissions_hash": "...", "next_run": "2026-11-04T08:00:00+10:00" | null } ]
}
```

The `tools` array is what the host forwards to the model, after any provider-specific encoding ([agent-surface](agent-surface.md)). The result of each method a tool maps to also carries `tool_result`, the same answer shaped for the model. `host_tools_suggested` describes `workflow_list_runs`, which the host implements if it wants to. `streams` lets the host rebuild its view after a restart without a second call.

## Host → engine methods

All take and return JSON objects. Errors use the vocabulary below.

| Method | Params | Result | Notes |
| --- | --- | --- | --- |
| `components.list` | `{}` | `{ components, pipeline_schema }` | Same as in `initialize`, plus the full JSON Schema of the current format version. |
| `pipeline.validate` | `{ pipeline }` | `{ valid, errors[], warnings[], permissions?, rendered? }` | Never touches network or state. |
| `pipeline.test` | `{ pipeline, input?, llm?, fixtures?, network?, clock?, state?, run_embedded? }` | `{ status, report, results[], llm_requests[] }` | Runs once in a sandboxed run process with the harness; see [agent-surface](agent-surface.md#pipeline-tests). `network` defaults to `mock`; `live` requires the host capability. |
| `stream.create` | `{ pipeline, start_paused?, schedule_description? }` | `{ stream_id, status: "pending_approval", permissions, permissions_hash, rendered }` | Validates first; returns `invalid_pipeline` on failure. |
| `stream.approve` | `{ stream_id, permissions_hash }` | `{ stream_id, status }` | `conflict` if the hash is stale. Status becomes `active`, or `paused` if `start_paused` was set. |
| `stream.update` | `{ stream_id, pipeline }` | `{ stream_id, status, permissions, permissions_hash, rendered, diff? }` | Subset → applied, status unchanged. Otherwise `pending_approval` with `diff`. |
| `stream.pause` | `{ stream_id }` | `{ stream_id, status: "paused" }` | A running run continues to completion; queued triggers for the stream are cancelled. |
| `stream.resume` | `{ stream_id }` | `{ stream_id, status: "active", next_run }` | No catch-up of occurrences missed while paused. |
| `stream.delete` | `{ stream_id }` | `{ stream_id, status: "deleted" }` | Cancels a running run of that stream first. Removes manifest and state. |
| `stream.list` | `{}` | `{ streams[] }` | As in `initialize`. `permissions_hash` and `permission_sentences` are the ones waiting for approval when the status is `pending_approval`. |
| `stream.get` | `{ stream_id }` | `{ stream_id, name, status, pipeline, permissions, permissions_hash, rendered, previous_pipeline?, pending?, created_at, updated_at, next_run }` | `pipeline` is the active one; `previous_pipeline` exists after an update; `pending` is a widening update waiting for approval, with its own `permissions_hash` and `rendered`, so a host that restarted can show the card. |
| `run.trigger` | `{ stream_id, scheduled_for?, reason? }` | `{ run_id, status: "queued" }` | Refused for `pending_approval` (`permission_denied`) and `paused` (`conflict`). `scheduled_for` is what the host's own scheduler meant this run to be; copied into the report. Collapses with a queued trigger for the same stream. |
| `run.cancel` | `{ run_id }` | `{ run_id, status }` | `not_found` if unknown; idempotent if already finished. |
| `schedule.preview` | `{ cron, timezone, after, count? }` | `{ occurrences: [RFC 3339] }` | Pure function; lets a host that owns the clock use the engine's cron semantics. |
| `shutdown` | `{ timeout? }` | `{}` | Response is sent after drain; then the engine exits 0. |

## Engine → host methods

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `host.llm` | request | `{ run_id, stream_id, step_id, message_id, attempt, idempotency_key, system?, messages: [{ "role": "user", "content": string }], max_output_tokens? }` | `{ text, usage: { input_tokens, output_tokens, cost_usd? }, provider, model, finished: "stop" \| "length" }` or a typed error |
| `host.result` | request | `{ run_id, stream_id, message_id, idempotency_key, result: { title, body, format } }` | `{ accepted: true, ref?: string }` where `ref` is the host's own identifier (Wriven: a thread id) |
| `run.started` | notification | `{ run_id, stream_id, trigger, scheduled_for, started_at }` | |
| `run.finished` | notification | `{ report }` | The full run report, below. |
| `stream.changed` | notification | `{ stream_id, status, reason }` | Sent when a status changes for a reason the host did not ask for directly: a `stream.update` that moved the stream to or from `pending_approval` (reasons `permissions_widened`, `update_applied`, `rolled_back`; that call usually comes from the model's tool, and the host needs to show the approval card), or an upgrade re-approval. |
| `log` | notification | `{ level, msg, run_id?, stream_id? }` | Mirrors stderr for hosts that do not read it. |

Rules for `host.llm`:

- The host decides provider and model (in Wriven: the ones the person chose when creating the automation). The engine never names a provider.
- `messages` is one user message in v0; the shape leaves room for more.
- The host **must** key its own storage by `idempotency_key` and return the stored reply for a repeated key within the run's lifetime without calling the provider again ([delivery-semantics](delivery-semantics.md#idempotency-keys)).
- The host **must** enforce its own count of calls per run against `limits.llm_calls_per_run` from the pipeline it approved, independent of the engine's count, and answer `budget_exceeded` when it is reached.
- The host should respond to `$/cancel` by aborting the provider request and answering `cancelled`.
- Usage is mandatory even when cost is not; the engine sums it into the report.

Rules for `host.result`:

- Same idempotency contract. The host may answer `accepted: true` with the existing `ref` for a repeated key.
- The host stores the result with the run's `scheduled_for` and `started_at` from the report, not the time it received the message, if its own timestamps matter to the person (Wriven's `append` stamps the time of the call; noted in the Wriven inbox).

## Typed errors

JSON-RPC `error` objects: `code` is an integer in the range -32000 to -32099 for application errors, `message` is an English sentence, `data` is `{ "kind": string, ... }`. `kind` is the contract; `code` exists for JSON-RPC conformance.

| kind | code | Direction | `data` extras | Meaning |
| --- | --- | --- | --- | --- |
| `parse_error` | -32700 | both | | A line is not valid JSON. |
| `invalid_request` | -32600 | both | | Not a JSON-RPC request, or a line over the 4 MiB limit. |
| `method_not_found` | -32601 | both | | No such method. |
| `invalid_params` | -32602 | both | `reason?` | Params do not fit the method, including a host ceiling above the compiled-in one. |
| `not_initialized` | -32001 | engine→host | | Request before `initialize`. |
| `unsupported_version` | -32002 | engine→host | `supported: [int]` | Protocol version mismatch. |
| `invalid_state_dir` | -32003 | engine→host | `reason` | Missing, wrong owner, wrong mode. |
| `conflict` | -32004 | both | `reason`, `current?` | Engine lock held; stale hash; paused; already running. |
| `not_found` | -32005 | both | | Unknown stream or run id. |
| `invalid_pipeline` | -32006 | engine→host | `errors[]` | As returned by validate. |
| `permission_denied` | -32007 | both | `host?`, `path?` | Run on unapproved stream; proxy refusal; sandbox denial. |
| `sandbox_unavailable` | -32008 | engine→host | `reason` | Cannot set up Seatbelt and `sandbox: required`. |
| `budget_exceeded` | -32010 | both | `limit`, `value` | LLM calls or cost cap reached; host or engine side. |
| `runs_per_day_exceeded` | -32011 | engine→host | `resets_at` | Trigger refused. |
| `timed_out` | -32012 | engine→host | `step_id?` | Run timeout; also a report status. |
| `cancelled` | -32013 | both | `reason` | Request or run cancelled. |
| `credentials_missing` | -32020 | host→engine | `provider?` | Host has no key for the chosen provider. |
| `credentials_rejected` | -32021 | host→engine | `provider?` | Provider refused the key. |
| `quota_exhausted` | -32022 | host→engine | `provider?`, `retry_after?` | Provider quota or credit exhausted. |
| `rate_limited` | -32023 | host→engine | `provider?`, `retry_after?` | HTTP 429 or equivalent. |
| `provider_unavailable` | -32024 | host→engine | `provider?`, `status?` | 5xx, network failure, timeout at the provider. |
| `provider_refused` | -32025 | host→engine | `provider?`, `reason?` | Content refused by the provider. |
| `host_error` | -32030 | host→engine | `reason` | Anything else on the host side; the run fails with it. |
| `internal` | -32099 | both | | Bug. Always reported, never retried. |

The engine never retries a `host.llm` error of any kind. It passes `retry_after` through into the report.

A report's `error.kind` may also be one of these, which are never RPC errors because no request failed: `process_exited` (the run process died), `memory_limit`, `unresolved_pointer` and `shape_mismatch` (a pointer that could only be checked at run time), `http_status`, `url_not_allowed`, `fixture_missing`, `feed_invalid`, `state_invalid`.

## Run report

Sent in `run.finished`, returned by `pipeline.test`, and the thing hosts store.

```json
{
  "report_version": 1,
  "run_id": "0193c8f0-...",
  "stream_id": "s_01HZ...",
  "stream_name": "Morning feed digest",
  "pipeline_format": "wriven-workflow/pipeline@1",
  "permissions_hash": "sha256:...",
  "trigger": "host" | "schedule" | "test",
  "scheduled_for": "2026-11-04T08:00:00+10:00" | null,
  "queued_at": "...", "started_at": "...", "finished_at": "...",
  "status": "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped",
  "error": { "kind": "provider_unavailable", "message": "...", "step_id": "summarize", "message_id": "...", "retry_after": null } | null,
  "warnings": [ { "step_id": "fetch", "message_id": "...", "code": "http_status", "message": "https://news.example.net/atom.xml returned 503" } ],
  "steps": [ { "step_id": "fetch", "in": 1, "out": 2, "dropped": 1, "duration_ms": 812 }, ... ],
  "llm": { "calls": 1, "input_tokens": 3120, "output_tokens": 410, "cost_usd": null, "requests": [ { "idempotency_key": "...", "attempt": 1, "provider": "anthropic", "model": "claude-sonnet-5-5", "duration_ms": 4210 } ] },
  "network": { "requests": 3, "bytes": 184022, "hosts": ["example.com", "blog.example.org", "news.example.net"], "denied": [] },
  "results": [ { "idempotency_key": "...", "ref": "thread:4821", "title": "Morning digest" } ],
  "state": { "committed": true, "dedupe_keys": 1043 },
  "sandbox": "seatbelt" | "none",
  "engine_version": "0.1.0"
}
```

Optional fields: `nothing_new` is `true` when a `succeeded` run delivered no result and has no warnings ([delivery-semantics](delivery-semantics.md#decisions-and-reasons)); `cancelled_at_step` names the step a cancelled run was on; `resets_at` is on a `skipped` report. `error` may carry extras from the typed error, such as `limit`, `value`, `host`, `reason`.

`report_version` changes when a field's meaning changes or a required field is removed. Adding optional fields does not bump it.

## Versioning rules

- `protocol_version`: integer. The engine supports a set; `initialize` either matches exactly or fails. v0 ships `1`. A method or field added within a version is optional and ignorable; anything else is a new version.
- `pipeline_formats`: see [pipeline-format](pipeline-format.md#versioning).
- `report_version`: as above.
- `wriven-workflow --version` prints all three plus the engine version as JSON so a host can check compatibility before spawning.

## Conformance fixtures

The repository ships `fixtures/protocol/` with one JSON file per scenario: the exact lines the host sends and the exact lines it must expect, with placeholders for ids and times. Scenarios in v0:

1. Initialize and shutdown, nothing else.
2. Validate the example pipeline (valid) and three invalid variants.
3. Create → approve → trigger → `host.llm` → `host.result` → `run.finished` (success).
4. Same, with the host returning `quota_exhausted` to `host.llm`; expect `failed` and no result.
5. Same, with the host's response to `host.llm` lost (fixture instructs the fake host to drop it); expect a repeated `idempotency_key` with `attempt: 2`, one provider call in the fake host log.
6. Update that narrows (applies) and update that widens (`pending_approval` with diff).
7. Cancel during `host.llm`; expect `$/cancel` and `cancelled`.
8. Stdin EOF during a run; expect `run.finished` cancelled and exit 0.
9. Two engines on one `state_dir`; second `initialize` fails `conflict`.
10. `sandbox: required` with `sandbox-exec` unavailable; expect `sandbox_unavailable` on trigger.

`wriven-workflow fake-host --conformance <dir>` replays them against an engine; a host author can read them as examples.

## Decisions and reasons

1. **NDJSON JSON-RPC, no headers.** Wriven's `ProcessRunner` already reads line-delimited JSON from Codex. Headers add nothing over stdio.
2. **Host sends `initialize`.** Same as LSP; the host knows its capabilities before the engine does, and the engine must not act before it knows the state directory and clock owner.
3. **Exact protocol version match.** Two sides built by the same person for one host do not need range negotiation; failing loudly is better than half-compatibility.
4. **`kind` strings as the error contract.** Wriven's `CredentialsError` has only `missing` and `rejected` (read in its code, 2026-11-03); the host will need the richer set for unsupervised runs regardless. Integer codes are kept for JSON-RPC tooling.
5. **Idempotency on the host.** The host is the only place that knows whether a provider call happened; the engine cannot deduplicate what it never saw complete.
6. **Report carries everything the host needs to render history.** The host never asks the engine about past runs; the engine keeps none.
7. **`schedule.preview` exposed even when the host owns the clock.** So that a host that chooses to store cron expressions gets the same occurrence arithmetic the engine would use, and so that tests on both sides share one truth.

## Risks

- The `host.llm` idempotency requirement is the piece most likely to be skipped by a host in a hurry. It is in the conformance fixtures for that reason.
- Large `host.result` bodies: a 4 MiB line limit bounds them; a digest is kilobytes. If a future component produces large outputs, the line limit becomes a chunking question, not a protocol change.
- `stderr` as a side channel: hosts that do not read it lose logs; `log` notifications mirror them for that reason, at the cost of duplication.

## Acceptance criteria

- The fake host passes all ten conformance fixtures against the engine, and the fixtures are the ones checked into `fixtures/protocol/`.
- A message of 4 MiB + 1 byte yields error `-32600` and the engine keeps serving.
- A request sent before `initialize` yields `not_initialized`; `initialize` with `protocol_version: 2` yields `unsupported_version` with `supported: [1]`.
- `initialize` with a `state_dir` of mode `0755` yields `invalid_state_dir`.
- Every error the engine emits has a `data.kind` from the table; a test enumerates emitted kinds against the table.
- `run.finished` reports validate against the published report JSON Schema.

## What the Wriven side needs (summary; details in [open-questions](../open-questions.md))

A client-side tool loop for at least one provider; approval UI for the rendered sentences (P3-6); a `host.llm` implementation with idempotency and per-run call counting; a `host.result` implementation that creates a thread with the run's timestamps; typed errors richer than `CredentialsError`; a `0700` state directory; a place for the binary; a decision on who owns the clock (this spec assumes `host`).
