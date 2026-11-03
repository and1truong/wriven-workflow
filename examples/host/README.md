# Example host

A working host for wriven-workflow in TypeScript. It shows, in code you can run, what [docs/host-integration.md](../../docs/host-integration.md) asks of a host, against the contract in [host-protocol](../../.agents/specs/host-protocol.md). Wriven Desktop will do the same in Swift; read this when something in the guide is unclear.

## Run it

Build the engine once from the repository root:

```bash
bun install && bun run build
```

Then, in this directory:

```bash
bun install
```

Without a key or network, with a provider that echoes the prompt:

```bash
bun main.ts run pipelines/hello.json --offline
```

With Claude. Credentials come from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile, read by this host and never by the engine:

```bash
bun main.ts run pipelines/hello.json
```

Talk to a model that builds automations with the engine's tools, then approve them in the terminal:

```bash
bun main.ts chat
```

Data goes to `.data/` (ignored by git): `engine/` is the engine's state directory, `results/` one Markdown file per delivered result, `reports/` one JSON run report per run. Options: `--engine <path>`, `--data <dir>`, `--sandbox optional`, `--model <id>`. `EXAMPLE_HOST_DEBUG=1` prints the engine's logs.

Tests, with the real engine binary, a scripted provider and a scripted model:

```bash
bun test
```

## Where each obligation is met

| Guide section | File | What it does |
| --- | --- | --- |
| Spawning and process handling | `rpc.ts` | Spawns `serve` with `/usr/bin` on `PATH`; one reader task for the engine's whole life; responses matched by `id`, out of order; requests from the engine answered without blocking the reader; `shutdown`, then stdin closed |
| Handshake, state directory, clock | `host.ts` `connect` | `clock: "host"`, a `0700` state directory, `sandbox: "required"` and refusal to go on without it, `host_response` above the provider timeout; rebuilds approved limits from `initialize.streams` after a restart |
| Approval UI | `host.ts` `approvalCard`, `approve`; `main.ts` `showCard` | Shows the engine's sentences as they are, or the diff for a widening update; approves with the hash it showed, so a stale card gets `conflict`; declining deletes the stream |
| `host.llm` | `host.ts` `answerLlm`; `provider.ts` | One record per `idempotency_key` for the run's lifetime, in flight or finished, so a repeat joins the same call; its own count against the approved `llm_calls_per_run`, answering `budget_exceeded`; `$/cancel` aborts the provider request; usage always, cost when the model's price is known |
| Typed errors | `provider.ts` `toHostError` | SDK error classes and `error.type` to `credentials_*`, `quota_exhausted`, `rate_limited` with `retry_after`, `provider_unavailable`, `provider_refused`, `cancelled` |
| `host.result` | `host.ts` `answerResult` | Idempotent by key; stamped with the run's `scheduled_for` and `started_at` from `run.started`, not the time of the call |
| Reports | `host.ts` `onNotification` | Keeps every `run.finished` report; the engine keeps no history |
| Tools | `agent.ts` | Forwards `initialize.tools` without `method`; runs each call as its RPC method; gives the model `tool_result`, never the `permissions_hash`; engine errors as `is_error` results with paths; tells the model about approvals in a system message after the person's next turn, never in a tool result |

## Choices made here, not by the protocol

- **No retries in the provider client** (`maxRetries: 0`). A failure reaches the engine as a typed error and shows in the report, which matches the engine's own rule. A host may decide otherwise.
- **Claude Opus 5.5 for both** the pipeline's model calls (effort `low`) and the chat (effort `high`), with server-side refusal fallback (`fallbacks: "default"`). The reply reports the model that actually served it.
- **Cost is an estimate** from published per-token prices in `provider.ts`, taken from the claude-api skill's model table cached 2026-10-06 and not verified against the pricing page. A model missing from the table reports no cost.
- **The idempotency record lives in memory.** It must outlive a lost response within a run, which it does; it does not survive a host restart, and neither does the run, since the engine is the host's child.

## Not here

A scheduler (this host runs on "run now" only; a real host passes `scheduled_for` to `run.trigger`), Gemini and OpenRouter tool encodings, the `workflow_list_runs` host tool, `llm_concurrency` above 1, and any real UI.

## Dependencies

This directory is its own package so that nothing it needs reaches the engine binary. `@anthropic-ai/sdk` 1.4.0 (Apache-2.0), pinned, because the guide's error mapping and tool loop are clearest with the official client. Its dependencies as installed on 2026-11-03: `@babel/runtime`, `@stablelib/base64`, `json-schema-to-ts`, `standardwebhooks`, `ts-algebra` (MIT), `@opentelemetry/api` (Apache-2.0), `fast-sha256` (Unlicense).

## What was run

On 2026-11-03, on macOS 27.0.1 with Bun 1.4.3: `bun test` here (8 tests) and `bun main.ts run pipelines/hello.json --offline`, both against the engine binary with the Seatbelt sandbox on. **Never run against the live provider**: there was no API key on the machine. `chat` has only been exercised through the scripted model in the tests.
