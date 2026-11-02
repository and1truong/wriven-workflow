# Architecture decision records

One record per choice with a large trade-off. A record is never edited to say something different; a new record supersedes it and both say so. All dated 2026-11-03 unless noted.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-runtime-bun.md) | Runtime and packaging: Bun, `bun build --compile`. Deno rejected after its end-of-development announcement; Node SEA rejected as experimental and large; system JavaScriptCore via Swift rejected as "build a runtime". | accepted |
| [002](002-host-owns-keys-clock-history.md) | The host owns provider keys, the clock (for Wriven) and run history; the engine owns operational state only. | accepted |
| [003](003-no-expression-language.md) | No expression language: JSON Pointer and placeholder-only templates; computation is a component. | accepted |
| [004](004-isolation-process-seatbelt-proxy.md) | Isolation by run-scoped child process + macOS Seatbelt + allowlisting proxy; own implementation with `srt` and Codex as references. | accepted |
| [005](005-permissions-derived-and-pinned.md) | Permissions derived from the pipeline, pinned by hash at approval, re-approved on widening. | accepted |
| [006](006-delivery-single-ack-strict-idempotent.md) | One ack per batch; strict processor errors with `on_error: skip`; idempotent `host.llm`/`host.result`; state committed on success; no cross-run redelivery. | accepted |
| [007](007-json-canonical-format.md) | JSON canonical pipeline format; provider-neutral JSON Schema subset for tools. | accepted |
| [008](008-mandatory-limits.md) | Mandatory limits in every pipeline, enforced by engine and host. | accepted |
