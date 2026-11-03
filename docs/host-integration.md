# Integrating wriven-workflow into a host

For whoever implements the Wriven side. The contract is [host-protocol](../.agents/specs/host-protocol.md); this is how to meet it, with what Wriven has today and what it lacks. Statements about Wriven were read from `wriven-desktop` at commit `f82a9c5` on 2026-11-03 and carry a file reference; statements about the engine were tested against the engine in this repository. No host has been integrated, so nothing here has been run from Swift. Every section is a condition from [open-questions](../.agents/open-questions.md#for-the-wriven-side-preconditions-for-integration).

Wriven's own rule still decides when this happens: scheduling by words works and a task exists that the narrow schema cannot express (sidecar decision 8).

## Start here

```bash
wriven-workflow --version
```

```bash
wriven-workflow doctor
```

`--version` prints JSON; check `protocol_versions` contains the version you speak. `doctor` exits 0 only if the sandbox works, proved by a child that tries everything forbidden. Refuse to offer automations otherwise, without parsing its prose.

Build a conformance run into your own tests. The archive ships the fixtures, so this needs no checkout: the fixtures in [`fixtures/protocol`](../fixtures/protocol/README.md) are also the examples for everything below.

```bash
wriven-workflow fake-host --conformance fixtures/protocol
```

That checks the engine. To check your host, replay the same scenarios from your side: they state the lines you send and must see, and fixture 5 catches a host without idempotency.

## Where the binary lives

Wriven is a bare executable with no `.app` bundle, so there is no "inside" for it yet. The options are in [packaging](../.agents/specs/packaging-and-release.md#installation-by-a-host); the binary is 62.5 MB on arm64 (measured 2026-11-03). A user-installed engine inherits Wriven's `PATH`-under-Finder limitation; spawn it by absolute path. The engine locates `sandbox-exec` through `PATH` in the environment you give it, so keep `/usr/bin` on that `PATH`, or it will report the sandbox unavailable.

## Spawning and process handling

Spawn `wriven-workflow serve` with stdin and stdout as pipes. No arguments carry configuration. stdout carries protocol lines only; stderr carries single-line JSON logs, also mirrored as `log` notifications if you do not read it.

`ProcessRunner` (`Sources/WrivenCore/ProcessRunner.swift`) is written for short request/response processes and stops with `SIGKILL` to the group. It does not fit here in three ways, and the engine needs a runner of its own:

- **The engine lives as long as the app.** Stop it by closing stdin, or `shutdown` to wait for the drain. With stdin closed the engine reports what it can and exits 0 within 10 seconds plus 1; killing it instead leaves the run process to notice on its own, which it does, but no final report reaches you.
- **Reading must never block on a request.** The engine sends you requests (`host.llm`, `host.result`) while you may be waiting on its answer to yours. Read lines continuously on their own task and correlate by `id`; responses arrive out of order. Handle `host.llm` asynchronously: it takes as long as the provider does.
- **Lines can be 4 MiB.** Your reader needs a buffer at least that large. A line of yours over the limit gets `-32600`, id `null`. A prompt or result too large for one line fails the run with `invalid_request`, reason `message_too_large`, rather than reaching you.

## Handshake

```json
{ "protocol_version": 1,
  "host": { "name": "wriven-desktop", "version": "0.14.0", "display_name": "Wriven" },
  "clock": "host",
  "state_dir": "/Users/me/Library/Application Support/Wriven/workflow",
  "sandbox": "required",
  "capabilities": { "llm": true, "llm_reports_cost": false, "results": true, "live_network_in_tests": false },
  "ceilings": { "llm_calls_per_run": 10, "runs_per_day": 24, "run_timeout": "10m" } }
```

The response carries `tools` for your model, `components`, the effective `ceilings`, and `streams`, so after a restart you can rebuild your view without another call. Check `sandbox.available`.

`timeouts.host_response` (default `120s`) is how long the engine waits for your answer before it treats it as lost and repeats the request: see below.

## State directory

Create a directory under Wriven's data directory, owned by the user, mode `0700`, and pass its path. Not Wriven's SQLite: the engine writes its own files and takes `engine.lock` there. Nothing in it is for the person: manifests, dedupe keys, schedule bookmarks, and a per-stream count of runs. Results and run history never go there; they come to you.

## Single instance

Wriven has no single-instance lock. A second engine on the same `state_dir` gets `conflict` with `reason: "engine_lock_held"` from `initialize` (fixture 9). The lock is `flock`, so the kernel frees it when the holder dies however it dies, and there is no stale lock to clean. Decide what the second Wriven does when it sees this: show that automations are running in the other window, or add a lock of its own.

## Clock

Declare `clock: "host"`. Wriven's scheduler and its missed-run policy stay Wriven's ("run once for the most recent missed occurrence when the app opens"), and pipelines with a `schedule` input are invalid for you (`schedule_requires_engine_clock`), so the agent uses `host_trigger`.

When your scheduler fires, call `run.trigger { stream_id, scheduled_for }`. The report keeps both `scheduled_for` and `started_at`, so you can show "ran at 08:03 for the 08:00 schedule". `schedule.preview { cron, timezone, after, count }` gives you the engine's cron arithmetic if you store cron expressions. To state your schedule in the approval text, pass `schedule_description` to `stream.create`; it appears verbatim after the first sentence as your statement, outside the hash.

Triggers queue one at a time per engine, and a second trigger for a stream already waiting collapses into it. Checking `runs_per_day` happens when a run would start, so `run.trigger` can answer `queued` and a `skipped` report with `resets_at` can follow.

## Running while the app is closed

Not supported by this design: no engine runs without its host. If Wriven ever wants it, a host-side headless mode would spawn the engine. Wriven's tests found Keychain access survives headless only with a stable signature, `codex` does not run under `launchd`, and `SMAppService` needs a `.app`. All of that is Wriven's, and none of it is in v0.

## Tools: a client-side tool loop for at least one provider

Wriven has none today (`Sources/WrivenCore/Provider.swift`: `reply` returns a `String`; it is a separate intent, [client-side-tool-loop](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W45/client-side-tool-loop.md)), and Stop, error, Regenerate and quit must stay consistent with "Interrupted replies".

Forward `initialize.tools` to the model in the provider's encoding. Each has `name`, `description`, `input_schema` and `method`; keep `method` for yourself. A test in this repository (`tests/conformance-kit.test.ts`) checks every schema stays in what all three accept.

| Provider | Definition | Call | Result |
| --- | --- | --- | --- |
| Anthropic | `{ name, description, input_schema }` | `tool_use { id, name, input }` | next user message, `tool_result { tool_use_id, content: <JSON string>, is_error }` first |
| Gemini | `{ functionDeclarations: [{ name, description, parameters }] }` | `parts[].functionCall { name, args }` with `thoughtSignature` | `parts[].functionResponse { name, response: <object> }` in a user turn |
| OpenRouter | `{ type: "function", function: { name, description, parameters } }` | `tool_calls[{ id, function: { name, arguments: <string> } }]` | `{ role: "tool", tool_call_id, content: <JSON string> }` |

When the model calls a tool, send `method` with the tool's input as params, then:

- **On success, give the model `result.tool_result`, not `result`.** `tool_result` is the answer shaped for the model: no `permissions_hash`, at most 32 KiB, still valid JSON when truncated. The rest of the result is yours, and you need `permissions_hash` for approval.
- **On a JSON-RPC error, give the model `{ "error": { "kind", "message", "errors"? } }`** from `error.data`, with `is_error: true` on Anthropic. Validation errors carry `path`s the model can repair from.

What each provider demands back, on top of that:

- **Anthropic:** replay `response.content` verbatim, including `thinking` blocks. Results for parallel calls go in one user message. Use `tool_choice: auto`: `any` and `tool` return 400 on current models.
- **Gemini:** echo the `functionCall` part with its `thoughtSignature`. Measured on Wriven's side: omitting it is a 400. `functionCall.id` is often absent, so match by name and order. `response` must be an object; `tool_result` always is.
- **OpenRouter:** resend `tools` on every request and echo the assistant message including `tool_calls` and `reasoning_details`. `arguments` is a JSON string; parse it.

A model can go from nothing to a pending automation with `workflow_list_components`, `workflow_validate_pipeline`, `workflow_test_pipeline`, `workflow_create_stream`. `host_tools_suggested` describes `workflow_list_runs`, a tool for you to implement if you want the model to read history.

## Approval UI (P3-6)

`stream.create` returns `{ stream_id, status: "pending_approval", permissions, permissions_hash, rendered }`. The tool result tells the model to stop and inform the person.

1. Show `rendered`, the sentences, as they are, with the stream's name. Code wrote them; the model has no field to write them. You may render from `permissions` instead if you want your own words; both are the contract. The last sentence is always the sandbox status: do not cut it.
2. On yes, call `stream.approve { stream_id, permissions_hash }`. A stale hash gets `conflict` with `current`, so a card showing old sentences cannot approve what it did not show.
3. On no, call `stream.delete`, or leave it pending. Tell the model on its next turn in a system note you write; never as a tool result.

Approval happens on create and on widening edits, not per run (sidecar decision 13). `stream.update` returns one of:

- `status` unchanged, no `diff`: within what was approved; nothing to show.
- `status: "pending_approval"` with `diff: { added, removed }` and a new `permissions_hash`: show the diff and approve as above. Until then the stream cannot run. `stream.changed` tells you this happened, since the call usually comes from the model. `stream.get` returns `pending`, so the card can come back after a restart.

Offer rollback through `previous_pipeline` from `stream.get`: `stream.update` with exactly that pipeline applies without approval.

## `host.llm`

```json
{ "run_id": "…", "stream_id": "…", "step_id": "summarize", "message_id": "m1.c", "attempt": 1,
  "idempotency_key": "<run_id>/summarize/m1.c",
  "system": "…", "messages": [{ "role": "user", "content": "…" }], "max_output_tokens": 1024 }
```

Answer `{ text, usage: { input_tokens, output_tokens, cost_usd? }, provider, model, finished: "stop" | "length" }`, or a typed error. You choose the provider and model: the ones the person picked for the automation. The engine never names one. The rules that matter:

- **Key your own record by `idempotency_key` for the run's lifetime, and answer a repeated key from it.** A response lost on the way back looks the same as a call that never ran; without this a lost line pays twice (fixture 5).
- **A key you are still working on must join that call, not start a second one.** The engine repeats a key when it has had no answer for `timeouts.host_response`, so a provider slower than 120 s is repeated while in flight. Set the timeout above your slowest expected call, and coalesce regardless.
- **Count calls per run yourself** against `limits.llm_calls_per_run` of the pipeline you approved, and answer `budget_exceeded { limit, value }` when reached. The engine counts too; a bug on one side then cannot overspend. A small map from `run_id` to a count is enough.
- **Usage is mandatory**, even without cost. A reply without it fails the run with `host_error`.
- **On `$/cancel { id }`, abort the provider request and answer `cancelled`.** The engine has already stopped waiting; answer anyway, as a late line is ignored.
- **The engine never retries an error of yours.** A `retry_after` you send goes into the report for you to show.

## Typed errors, from what Wriven has

Wriven's `CredentialsError` has only `.missing` and `.rejected`, and everything else is a `WrivenError(message)` (`Sources/WrivenCore/Provider.swift:130`); a 429 is a message string. Unsupervised runs need the richer set, because the person is not there to read a message: you have to decide what to do from the kind.

| Provider failure | Kind | Extras | From Wriven today |
| --- | --- | --- | --- |
| No key for the provider | `credentials_missing` | `provider?` | `CredentialsError(.missing)` |
| Provider refused the key | `credentials_rejected` | `provider?` | `CredentialsError(.rejected)` |
| Quota or credit exhausted | `quota_exhausted` | `provider?`, `retry_after?` | message string; needs classifying |
| HTTP 429 or equivalent | `rate_limited` | `provider?`, `retry_after?` | message string; needs classifying |
| 5xx, network failure, timeout | `provider_unavailable` | `provider?`, `status?` | message string; needs classifying |
| Content refused (`refusal`, `SAFETY`, `content_filter`) | `provider_refused` | `provider?`, `reason?` | needs adding |
| Calls per run reached | `budget_exceeded` | `limit`, `value` | new |
| `$/cancel` | `cancelled` | `reason` | Stop |
| Anything else | `host_error` | `reason` | `WrivenError` |

Send `{ "code": <the table's integer>, "message": "<an English sentence>", "data": { "kind": "…", … } }`. An unknown kind is treated as `host_error`. The full table is in [host-protocol](../.agents/specs/host-protocol.md#typed-errors).

## Usage and cost (P1-3)

Without P1-3, declare `llm_reports_cost: false`. The cost sentence then reads "Cost limit: not enforceable with this provider." and the call cap still works. When Wriven gains cost tracking, return `usage.cost_usd` and declare `true`, with no engine change: the engine sums it and fails the run with `budget_exceeded` when the cap is passed.

## `host.result`

```json
{ "run_id": "…", "stream_id": "…", "message_id": "m1.c", "idempotency_key": "<run_id>/m1.c",
  "result": { "title": "Morning digest", "body": "…", "format": "markdown" } }
```

Answer `{ accepted: true, ref? }`, with `ref` your own identifier (a thread id). The same idempotency rule holds: answer a repeated key with the same `ref` and create nothing new. A `host_result` with `retry` repeats the same key on your errors.

**Timestamps:** Wriven's `append` stamps the time of the call. Store a result with the run's `scheduled_for` and `started_at` instead, or a digest delivered late looks written late. `host.result` carries neither, so take them from `run.started`, which comes first.

## Reports

`run.finished` carries the full report, and you keep it: the engine stores no history. Schema: `report_schema` in `components.list`, and `schemas/run-report-1.json` in the release archive.

| `status` | Meaning | Show |
| --- | --- | --- |
| `succeeded` | Delivered, or nothing to deliver | With `nothing_new: true`: every source read fine and there was nothing new. Without results and with `warnings`: sources failed and were skipped, which is not "nothing new" |
| `failed` | `error.kind`, `error.message`, `error.step_id` | The message; `retry_after` if present |
| `timed_out` | Passed `run_timeout` | |
| `cancelled` | `run.cancel`, `shutdown`, host gone, stream paused or deleted before starting; `error.reason` says which | In your own words ("Interrupted") |
| `skipped` | `runs_per_day` reached; `resets_at` says when it frees | |

A failed run is not retried and commits no state, so the next run sees the same items again. The next occurrence is the retry.

## Showing results

Results contain model output derived from untrusted web content. Show them as content; never act on them automatically. Inside a run the model has no tools, so injected text can only shape text. But continuing a result thread with a tool-capable provider hands that text to a model that can act, which Wriven already accepted for Codex in scheduled-actions decision 9. Whether to strip or mark links is yours to decide ([threat model](../.agents/specs/threat-model.md) T2).

## What was not run

- No Swift host has spoken to the engine.
- Providers' encodings above come from research dated 2026-11-03 ([tool calling](../.agents/research/research-tool-calling.md)); the engine knows no provider, and the schema-subset test checks shapes, not live APIs.
- Live network has been exercised only against a local TLS fixture server, never the open web.
