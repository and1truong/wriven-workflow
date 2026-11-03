# engine-06: `parse_feed`, `dedupe` with commit-on-success, `collect`; the feed example runs end to end

**Spec:** [pipeline-format](../../../specs/pipeline-format.md) (the three components, the example document), [delivery-semantics](../../../specs/delivery-semantics.md#state-and-acknowledgements), [permissions](../../../specs/permissions.md) (state sentence, `receives_fetched_content`).

**To build:** `parse_feed` for RSS 2.0, Atom 1.0 and RSS 1.0 with HTML-to-text, `id` fallback rules, `max_entries`, `on_error`. `dedupe` with per-stream state file, `remember` expiry, `max_keys`, in-memory during the run, atomic commit only on `succeeded`. `collect` with `min_items` (drop below as success) and `max_items` (warning). Permissions: state sentence; "Sends fetched web content to the AI provider." when `http_fetch` precedes `host_llm`. A fixture corpus of real-world feeds (sanitized) under `fixtures/feeds/`.

**Blocked by:** [engine-05](engine-05-proxy-http-fetch.md).

**Verification:** The example pipeline from the spec runs against the fixture server with mocked `host.llm` and produces one result whose prompt contains the fixture entry titles; `state.json` has the entry ids afterwards. Running again → `collect` drops the empty batch, `succeeded`, no `host.llm` call, report says nothing new. A run that fails at `host_result` leaves `state.json` unchanged; the next run sees the same items. Expired keys (fake clock past `remember`) are re-admitted. Every feed in the corpus parses; malformed input → error with `on_error: fail`, skip with `skip`. Worked-example rendering matches all ten lines. Decide and record the open point on a `succeeded_empty` status.

**Status:** done 2026-11-03

- [x] `parse_feed` with corpus tests
- [x] `dedupe` state, expiry, commit-on-success
- [x] `collect`
- [x] Sentences: state, fetched content to AI; worked example byte-exact
- [x] Example pipeline green end to end; `succeeded_empty` decided
