# ADR 002: The host owns provider keys, the clock (for Wriven) and run history; the engine owns operational state only

Date: 2026-11-03. Status: accepted (Hong, grilling decisions 1, 8).

## Context

Wriven's grilling of the sidecar idea on 2026-11-03 (round 2, decisions 8 and 15) settled that Wriven carries keys, provider calls, SQLite, schedule, approval and usage, and that the sidecar "chỉ còn đọc feed, lọc bài mới và nối các bước". Wriven's scheduled-actions grilling the same day settled that nothing runs while the app is closed. The brief's principle 2 (`launchd` runs Wriven with `--run-scheduled`) therefore describes a future path, not v0.

Separately, Wriven's `ChatStore.append` stamps the time of the call, `messages` has no run identifier, and there is no single-instance lock (read in Wriven's code 2026-11-03). Any design in which the engine writes into Wriven's database, or keeps its own copy of results, collides with those facts.

## Decision

- The engine never reads, stores or receives a provider key. Every model call is `host.llm` to the parent; the host calls the provider and returns text and usage.
- Clock ownership is declared at `initialize`. Wriven declares `clock: host` and triggers runs itself; the engine's scheduler exists for standalone use and tests and is off for Wriven.
- The engine keeps no run history and no results. Each run ends in a `run.finished` report the host stores; each result is a `host.result` the host stores. The engine's state directory holds only what it needs to run correctly next time: dedupe keys and schedule bookmarks, per stream, as files.
- The engine never writes to the host's database or data directory except the `state_dir` the host hands it.

## Consequences

- Wriven's transparency story stays in one place: what was sent, to whom, at what cost, is in Wriven's own records with Wriven's own timestamps (taken from the report's `scheduled_for`/`started_at`).
- The host must implement: `host.llm` with idempotency and per-run call counting; `host.result` with idempotency; storage of reports; its own scheduler with missed-run policy. `schedule.preview` gives it the engine's occurrence arithmetic so the two never disagree.
- The engine is small and stateless enough to be killed and restarted at will; restart recovery is reading manifests and bookmarks.
- Running while the host is closed is not possible in this design without a host-side headless mode; recorded as a Wriven-side condition in [open-questions](../open-questions.md).
- A host that owns the clock also owns catch-up semantics; the engine renders the host's description of them in the permission sentences rather than its own.
