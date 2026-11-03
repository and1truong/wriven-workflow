# Agent surface: the tools a model uses

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 9, 14), [tool-calling research](../research/research-tool-calling.md) (read 2026-11-03), Wriven [client-side tool loop intent](https://github.com/and1truong/wriven-desktop/blob/main/.agents/inbox/2026W45/client-side-tool-loop.md). Stage: **Design — spec**.

## Scope

The tool definitions the engine publishes, their JSON Schema subset, how a host encodes them per provider, how tool calls map to RPC methods, how results are shaped and truncated, the approval hand-off, and the `pipeline.test` harness including embedded tests. The host's own tool loop (how it calls the provider, streams, stores tool blocks) is the host's business and is listed in [open-questions](../open-questions.md).

## Observable behaviour

- `initialize` returns a `tools` array. Each entry has `name`, `description`, `input_schema`, and `method`. The host forwards the first three to the model in its provider's encoding and, when the model calls a tool, sends `method` with the tool's input as params and returns the RPC error, or `result.tool_result`, as the tool result. `tool_result` is the same answer shaped for the model: no `permissions_hash`, at most 32 KiB. The rest of the RPC result is for the host, which needs the hash for `stream.approve`.
- A model can go from "nothing" to an approved, running automation with four tool calls: `workflow_list_components` (optional), `workflow_validate_pipeline`, `workflow_test_pipeline`, `workflow_create_stream`, and then the person approves outside the model's control.
- No tool approves anything, starts a run on an unapproved stream, or reads provider keys. The approval step is a host UI action that calls `stream.approve`.
- Tool results are JSON, never larger than 32 KiB; larger payloads are truncated as valid JSON with `truncated: true`, `original_size`, and a `preview`.
- Every tool error is a JSON object with `error: { kind, message, errors?[] }` so the model can repair a pipeline from the message. Validation errors carry paths.

## Tools (v0)

Names match `^[a-zA-Z0-9_-]{1,64}$` (OpenRouter's limit is the tightest of the three providers, [research](../research/research-tool-calling.md)). All are prefixed `workflow_`.

| Tool | Method | Input | Result (abridged) |
| --- | --- | --- | --- |
| `workflow_list_components` | `components.list` | `{ "kind"?: "input" \| "processor" \| "output" }` | `{ components: [{ type, kind, summary, schema }], format: "wriven-workflow/pipeline@1", ceilings }` |
| `workflow_validate_pipeline` | `pipeline.validate` | `{ "pipeline": object }` | `{ valid, errors[], warnings[], permission_sentences[] }` |
| `workflow_test_pipeline` | `pipeline.test` | `{ "pipeline", "input"?, "llm"?, "fixtures"?, "network"?: "mock" \| "live", "clock"?, "mocks"? }` | `{ status, results[], llm_requests[], logs[], clamped[], warnings[], error?, steps[] }` |
| `workflow_create_stream` | `stream.create` | `{ "pipeline", "start_paused"?: boolean }` | `{ stream_id, status: "pending_approval", permission_sentences[] , next: "The person must approve these permissions in the host before the automation runs." }` |
| `workflow_update_stream` | `stream.update` | `{ "stream_id", "pipeline" }` | `{ stream_id, status, permission_sentences[], diff?: { added[], removed[] } }` |
| `workflow_pause_stream` | `stream.pause` | `{ "stream_id" }` | `{ stream_id, status }` |
| `workflow_resume_stream` | `stream.resume` | `{ "stream_id" }` | `{ stream_id, status, next_run }` |
| `workflow_delete_stream` | `stream.delete` | `{ "stream_id" }` | `{ stream_id, status: "deleted" }` |
| `workflow_list_streams` | `stream.list` | `{}` | `{ streams: [{ stream_id, name, status, next_run, permission_sentences[] }] }` |
| `workflow_get_stream` | `stream.get` | `{ "stream_id" }` | `{ ..., pipeline, previous_pipeline? }` |
| `workflow_run_now` | `run.trigger` | `{ "stream_id" }` | `{ run_id, status: "queued" }` |

Not an engine tool: **run history** (`workflow_list_runs`). The host owns run reports ([ADR 002](../decisions/002-host-owns-keys-clock-history.md)); the host may expose its own tool with that name and the shape `{ stream_id?, limit? } → { runs: [report summaries] }`. The engine's `initialize` response includes a `host_tools_suggested` list with this one entry and a description, so the host does not have to invent it.

Descriptions are written for the model: what the tool does, when to call it, what to do with the result. Example for `workflow_create_stream`:

> Install a validated pipeline as an automation. Call `workflow_validate_pipeline` first and fix every error. The result lists the permissions the automation will have, in plain English; the person must approve them in the app before anything runs, so tell them what you created and stop. Use `start_paused: true` when the person wants to review before the first run.

## Schema subset

Every `input_schema` uses only the intersection that works on Anthropic, Gemini (`parameters`) and OpenRouter ([research](../research/research-tool-calling.md), "Common denominator"):

- Root `type: "object"` with `properties`, `required`.
- Property types `string`, `number`, `integer`, `boolean`, `array`, `object`; `description` on each; `enum` of strings; `items` for arrays; nested objects at most three deep.
- Not used anywhere: `$ref`, `$defs`, `oneOf`, `anyOf`, `allOf`, `const`, `additionalProperties`, `pattern`, `format`, `minimum`, `maximum`, `minLength`, `maxLength`, `default`, `minItems > 1`.

The `pipeline` argument is typed as `{ "type": "object", "description": "A wriven-workflow pipeline document. Get the full schema from workflow_list_components." }` with no nested schema, because the pipeline schema uses `oneOf` for components and would not survive the subset. Validation happens in the engine, with paths in the errors, which is where a model learns the shape.

A test in the repository encodes every tool for all three providers and asserts: Anthropic accepts it with `strict: false`; Gemini `parameters` contains no unsupported keyword; OpenRouter name length ≤ 64.

## Encoding per provider (for the host)

| Provider | Tool definition | Call | Result message |
| --- | --- | --- | --- |
| Anthropic | `{ name, description, input_schema }` | `tool_use { id, name, input }` | next user message, `tool_result { tool_use_id, content: <JSON string>, is_error }` first |
| Gemini | `{ functionDeclarations: [{ name, description, parameters }] }` | `parts[].functionCall { name, args }` with `thoughtSignature` to echo | `parts[].functionResponse { name, response: <object> }` in a user turn |
| OpenRouter | `{ type: "function", function: { name, description, parameters } }` | `tool_calls[{ id, function: { name, arguments: <string> } }]` | `{ role: "tool", tool_call_id, content: <JSON string> }` |

Engine results are JSON objects, so they fit Gemini's `response` object requirement directly; for Anthropic and OpenRouter the host serializes them. Errors: the engine returns a JSON-RPC error; the host wraps it as `{ "error": { "kind", "message", "errors"? } }` in the tool result (with `is_error: true` on Anthropic). Forced tool use is not relied on anywhere: Anthropic's `any`/`tool` return 400 on current models, so the host uses `auto` and a prompt.

## Approval hand-off

1. Model calls `workflow_create_stream`. Engine stores `pending_approval`, returns sentences.
2. Host shows an approval card with the sentences and the stream name (Wriven: P3-6). The model's tool result tells it to stop and inform the person.
3. Person approves → host calls `stream.approve { stream_id, permissions_hash }`. Person refuses → host calls `stream.delete` or leaves it pending; either way the model is told on its next turn through a system note the host writes, not through a tool result.
4. Later edits via `workflow_update_stream` follow the same path when they widen permissions; the result's `diff` is what the host shows.

The model never sees `permissions_hash`; the host keeps it from the create/update result.

## Pipeline tests

`workflow_test_pipeline` runs the pipeline once in a sandboxed run process with the harness in place of the world:

| Param | Meaning | Default |
| --- | --- | --- |
| `input` | `{ "messages": [{ data, meta? }] }` replaces the input component's output for this run | the input component's normal single trigger message |
| `llm` | `{ "mode": "mock", "responses": [string] }` answers `host_llm` calls in order (the last response repeats); `{ "mode": "echo" }` returns the prompt prefixed with `[mock reply] ` | `echo` |
| `fixtures` | `{ "<url>": { "status": 200, "content_type": "application/rss+xml", "body": "<xml…>" } }` answered to `http_fetch` from a table in the run process, with no socket and no proxy, so the test's profile allows no network at all. An HTTPS server would have to mint certificates for whatever host an agent names and ship a trust root in the binary. The allowlist check on URLs and redirects still runs. | none |
| `network` | `mock`: any URL without a fixture fails with `fixture_missing`; `live`: real HTTPS through the proxy with the derived allowlist, only when the host allowed it at `initialize` | `mock` |
| `clock` | RFC 3339 instant the run believes is "now"; affects `dedupe` expiry and the trigger message's `scheduled_for` | real time |
| `state` | `{ "version": 1, "seen": { "<step_id>": { "<key>": <RFC 3339> } } }`, keys the run believes it has already seen. A test keeps no state, so this is how it can exercise `dedupe` | empty |
| `mocks` | `{ "<step id>": { "messages": [{ data, meta? }] } \| { "replies": [string] } \| { "fail": { code, message? } } \| { "cases": [{ when?, <one of those> }] } }` replaces processor steps, the first case whose `when` holds per unit, no match failing with `mock_unmatched`: a mocked step does not run and emits its messages per unit, or a mocked `host_llm` renders, records and counts its prompt and answers from `replies`, ahead of `llm`. Checked with the pipeline; a mocked step's report entry has `mocked: true` ([test-mocks](test-mocks.md)) | none |

The result is a run report with `trigger: "test"`, plus `results[]` (what would have gone to `host.result`) and `llm_requests[]` (prompts the host would have received). Tests never write state and never call the real host for `host.llm` or `host.result`.

**Concurrency in tests.** `llm.mode: "mock"` answers in call order, so under `pipeline.test` every `concurrency` runs at 1 and the result's `clamped` lists those steps (`"for_each:<id>"`). Concurrency itself is covered by the engine's own tests against the fake host.

**Embedded tests.** A pipeline may carry `tests: [{ name, input?, llm?, fixtures?, network?, clock?, state?, expect: { status, results_count?, result_body_contains?: [string], warnings_count?, error_kind?, logs_contain?: [string] }, mocks? }]`. `wriven-workflow test <file>` and `pipeline.test` with `{ "run_embedded": true }` run them all and return `{ status: "passed" | "failed", passed, failed, tests: [{ name, passed, failures[], status }] }`. The assertion vocabulary is deliberately small; it is what an agent can write without a language, modelled on Redpanda Connect's `output_batches` conditions ([research](../research/research-benthos.md) §7).

## Result truncation

If a tool result exceeds 32 KiB when serialized, the engine replaces the largest string fields first (bodies, prompts) with `{ "preview": first 2 KiB, "original_size": n, "truncated": true }` until it fits, then truncates arrays from the end with a trailing `{ "truncated": true, "omitted": k }` element. The structure stays valid JSON so the model can still read the rest. Pipelines are never truncated in `workflow_get_stream`; a pipeline that does not fit (it would have to exceed the format's own size limits) is an engine bug.

## Decisions and reasons

1. **Engine publishes the tools.** One source of truth for names, schemas and wording; hosts do not drift. Wriven's tool loop stays provider-specific but tool-agnostic.
2. **1:1 tool-to-method.** No tool does two things; the model's mental model of the engine is the protocol.
3. **Approval is not a tool.** The whole safety argument rests on the person approving sentences the model did not write and cannot trigger acceptance of.
4. **Run history is the host's tool.** The engine has no history; faking one would mean storing results, which the design forbids.
5. **Test harness in the engine, callable as a tool.** Decision 15 of the Wriven sidecar grilling requires mocked LLM in tests. Making it a tool means the model tests before it asks for approval, which is the behaviour we want.
6. **Small assertion vocabulary.** Enough to catch "the pipeline produced nothing" and "the summary mentions the feed title"; anything richer is a language.

## Risks

- Models may call `workflow_create_stream` without validating or testing first. The create path validates anyway; the description nudges the order; the host can refuse to show an approval card for a stream that has never been tested (its choice, recorded in open questions).
- Fixture authoring: for `network: mock`, the agent must supply feed XML. That is realistic for tests of structure but not of real content; `live` exists for the host that allows it, and `mocks` let a test skip fetching and parsing to test what comes after them.
- Gemini's `response` must be an object and Gemini may omit `functionCall.id`; the host matches by name and order. Noted for the Wriven side.

## Acceptance criteria

- `initialize.tools` contains exactly the eleven tools above, each with a `method` that exists in [host-protocol](host-protocol.md).
- The schema-subset test passes for all three provider encodings.
- Calling `workflow_create_stream` with an invalid pipeline returns `error.kind = "invalid_pipeline"` with at least one `errors[].path`.
- `workflow_test_pipeline` on the example pipeline with three fixtures and `llm.mode = "mock"` returns `status: "succeeded"`, one result whose body is the mocked response, and `llm_requests[0].prompt` containing the fixture entry titles; `state.json` does not exist afterwards.
- `workflow_test_pipeline` with `network: "live"` against a host that did not allow it returns `permission_denied`.
- A result larger than 32 KiB is returned truncated, parses as JSON, and contains `truncated: true`.
- Embedded tests with `expect.status: "failed"` and `error_kind: "fixture_missing"` pass when a fixture is deliberately omitted.

## Open points

- Whether `workflow_get_stream` should return the pipeline at all to the model, or only the sentences, to keep the model from "fixing" an approved pipeline by rewriting it wholesale. Current answer: return it; edits go through update and re-approval anyway.
- Tool descriptions are English prose that will need iteration against real model behaviour; treat them as product copy with tests (the schema-subset test) rather than code comments.
