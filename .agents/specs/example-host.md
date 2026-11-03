# Example host: a working host in the repository

Source: [example-host grilling record](../inbox/2026W45/example-host.md) (decisions 1–10, 2026-11-03), [host-protocol](host-protocol.md), [agent-surface](agent-surface.md), [host-integration guide](../../docs/host-integration.md), Claude pricing (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-03). Stage: **Built before this spec (commit `be50038`); spec written from the grilling record afterwards. Accepted once Hong has read the code; tickets cover the differences.**

## Scope

`examples/host/`: a host for the engine, in TypeScript, that a person can run in a terminal and a reader can follow line by line next to the [guide](../../docs/host-integration.md). It meets every host obligation of [host-protocol](host-protocol.md) with Claude as the provider, and runs the client-side tool loop of [agent-surface](agent-surface.md).

Not in scope: a scheduler (runs happen on "run now"), Gemini and OpenRouter encodings, the `workflow_list_runs` host tool, `llm_concurrency` above 1, a graphical interface, and anything that ships with the engine.

## Observable behaviour

- `bun main.ts run <pipeline.json>` validates the pipeline, creates a stream, shows the approval card (the engine's sentences, verbatim), and on "y" approves it with the hash it showed, then offers to run it once and prints the result and a report summary: status, model calls, tokens, estimated cost. On "n" it deletes the stream. `--offline` answers `host.llm` with a provider that echoes the prompt, so this works without a key or network.
- `bun main.ts chat` is a conversation with a model that has the engine's `workflow_*` tools. After each turn, every stream the model created or widened gets a card; the person's answer reaches the model as a system message after their next turn.
- Data lives under `--data` (default `examples/host/.data/`, ignored by git): `engine/` is the state directory (`0700`), `results/<ref>.md` one file per delivered result, stamped with the run's `scheduled_for` and `started_at`; `reports/<run_id>.json` every run report.
- The host refuses to go on when `sandbox: "required"` and the engine reports the sandbox unavailable.
- `bun run test:example` at the repository root runs the example's tests against the compiled engine with a scripted provider and a scripted model: no network, no key.

## Host obligations and where they are met

| Obligation ([host-protocol](host-protocol.md)) | Where |
| --- | --- |
| Spawn `serve`; read continuously on its own task; match responses by `id`; never block reading on a request from the engine; `shutdown` then close stdin | `rpc.ts` |
| `initialize` with `clock: "host"`, a `0700` state directory, `sandbox`, capabilities, `timeouts.host_response` above the provider timeout | `host.ts` |
| Rebuild what the host must know from `initialize.streams` after a restart | `host.ts` |
| Approval with the hash that was shown; diff for a widening update; decline deletes | `host.ts`, `main.ts` |
| `host.llm`: one record per `idempotency_key` for the run's lifetime, in flight or finished; own count against the approved `llm_calls_per_run`, `budget_exceeded { limit, value }`; usage always; `$/cancel` aborts the provider call | `host.ts` |
| Provider failures as typed errors | `provider.ts` |
| `host.result`: idempotent by key, stamped with the run's times | `host.ts` |
| Keep every `run.finished` report | `host.ts` |
| Tools: forward `initialize.tools` without `method`; give the model `tool_result`, never `permissions_hash`; engine errors as `is_error` results with their `errors`; approval news as a host-written system message, never a tool result | `agent.ts` |

## Decisions and reasons

From the grilling record:

1. **Host and tool loop, not host alone** (decision 1). The tool loop is the part Wriven lacks entirely, and the part a prose guide explains worst.
2. **On `main`, under `examples/host/`** (decision 2). Nothing in it is private, and it belongs next to the guide it illustrates.
3. **Its own package; `bun test` at the root stays the engine suite** (decision 3). The engine ships as one binary and every engine dependency is supply chain for the host; a separate `package.json` and lockfile keep the example's dependencies out of it. `bunfig.toml` sets `[test] root = "tests"`, and `bun run test:example` runs the example's tests.
4. **The official SDK, not raw HTTP** (decision 4). Typed error classes make the provider-to-kind mapping readable, and the SDK's types cover the tool loop. **Dependency:** `@anthropic-ai/sdk` 1.4.0, pinned, Apache-2.0, with `@babel/runtime`, `@stablelib/base64`, `json-schema-to-ts`, `standardwebhooks`, `ts-algebra` (MIT), `@opentelemetry/api` (Apache-2.0) and `fast-sha256` (Unlicense), as installed on 2026-11-03. Apache-2.0 is permissive and fits an MIT repository; nothing here is redistributed, so no NOTICE obligation arises.
5. **Claude Opus 5.5 by default** (decision 5): effort `low` for `host.llm`, `high` for the chat, server-side refusal fallback (`fallbacks: "default"`), `--model` to change it. The reply names the model that actually served it.
6. **No retries in the provider client** (decision 6). A failure reaches the engine as a typed error and shows in the report, the same rule the engine follows. A real host may decide otherwise.
7. **Cost is reported, from published prices** (decision 7). The host declares `llm_reports_cost: true` and sends `usage.cost_usd` computed from a price table in the code, which carries its source and the date it was read, including Haiku 5.5's higher price for prompts over 100 000 tokens. A model missing from the table reports no cost.
8. **The engine returns the diff of a waiting update** (decision 8). A host that restarts must show the same card it would have shown from `stream.update`; computing the diff on the host side duplicates the engine's rule and can drift from it. See "Changes to other specs".
9. **One live run, recorded** (decision 9): `run` with `pipelines/hello.json` and one `chat` turn against the real provider, with the date, model and tokens written into the example's README.
10. **Spec after the fact; tickets for the differences** (decision 10).

## Changes to other specs

- [host-protocol](host-protocol.md): `stream.get`'s `pending` gains `diff: { added, removed }`, the same object `stream.update` returned when it moved the stream to `pending_approval`. Done in example-host-01.
- [docs/host-integration.md](../../docs/host-integration.md): the restart sentence names the diff.

## Risks

- **The example drifts from the protocol.** Mitigated by its tests running against the compiled engine and by a test that compares its error-code table with the engine's. Not mitigated: nothing runs the example's tests in `bun test` at the root; whoever changes the protocol must run `bun run test:example`.
- **The price table goes stale.** Costs are labelled as estimates and carry the date the prices were read.
- **The live provider has never been called** until example-host-03 is done. The error mapping is tested with constructed SDK errors only.

## Acceptance criteria

- `bun run test:example` passes, and `bun test` at the root runs exactly the files under `tests/`.
- `bun main.ts run pipelines/hello.json --offline` with "y", "y" prints a succeeded run, one model call, and the echoed result, with the sandbox on.
- After `stream.update` widens an approved stream, `stream.get` returns `pending.diff`, and the example shows that diff without computing its own.
- A reply from `claude-haiku-5-5` with 150 000 input tokens is costed at the over-100 000 price.
- The README records one live `run` and one live `chat` turn with date, model and tokens.

## Open points

1. **Running the example's tests in CI.** Once Actions quota exists for private repositories, the release workflow could run `test:example` too.
