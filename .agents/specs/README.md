# Specifications

Index of `.agents/specs/`. Each spec has scope, observable behaviour, decisions with reasons, risks, acceptance criteria and open points. All derive from the [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (2026-11-03). Stage for all: **Design — spec; nothing implemented.**

Read in this order the first time:

1. [architecture](architecture.md) — processes (host, engine, sandboxed run process), modules, stream and run lifecycles, one run at a time, engine owns no history.
2. [pipeline-format](pipeline-format.md) — the JSON document, eleven v0 components (`host_trigger`, `schedule`, `inject`; `http_fetch`, `parse_feed`, `dedupe`, `collect`, `template`, `host_llm`; `host_result`, `drop`), JSON Pointer only, mandatory limits, validation codes, versioning.
3. [delivery-semantics](delivery-semantics.md) — one ack per batch, strict processor errors with per-component `on_error: skip`, idempotency keys on `host.llm` and `host.result`, state committed on success only, no cross-run redelivery, cancellation and shutdown.
4. [permissions](permissions.md) — permissions derived from the pipeline, canonical object and hash, English sentence templates with a worked example, subset rule on update, Seatbelt profile and proxy allowlist derived from the same object.
5. [host-protocol](host-protocol.md) — **the integration contract**: NDJSON JSON-RPC 2.0 over stdio, `initialize` handshake (clock owner, state dir, sandbox policy, capabilities, ceilings), every method both ways, typed error kinds, the run report, conformance fixtures, what Wriven needs.
6. [agent-surface](agent-surface.md) — the eleven `workflow_*` tools, provider-neutral schema subset, per-provider encoding for the host, approval hand-off outside the model, `pipeline.test` harness with mocked LLM and fixtures, result truncation.
7. [scheduling](scheduling.md) — host-owned clock for Wriven, engine scheduler otherwise; cron 5-field with IANA zones, DST rules, declared missed-run policy (`skip` / `run_once` / `run_all`), no catch-up after resume, `schedule.preview`.
8. [packaging-and-release](packaging-and-release.md) — Bun compile per architecture, re-sign in CI, entitlements and notarization path, `--version` and `doctor`, zero-dependency goal, release checks, host installation options.
9. [threat-model](threat-model.md) — twelve threats from agent error, fetched content, supply chain, local attacker and engine bugs, with controls per spec and residual risks.
