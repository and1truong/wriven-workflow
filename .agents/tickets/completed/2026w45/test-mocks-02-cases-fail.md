# test-mocks-02: cases chosen by `when`, `fail`, `mock_unmatched`

**Spec:** [test-mocks](../../../specs/test-mocks.md) (format, what `when` sees, validation, worked example), [composition](../../../specs/composition.md#condition) (the `condition` type).

**To build:** conditional mocks on top of test-mocks-01.
- **`cases[]`.** Each case has an optional `when` and exactly one of `messages`, `replies`, `fail`. The first true case wins; a case without `when` must be last. The shorthand forms of test-mocks-01 become one default case. Ceiling: 20 cases per mock.
- **What `when` sees**, per unit: `{ "url" }` for `http_fetch`, `{ "prompt", "system"? }` for `host_llm`, `{ "items", "count" }` with the first message's `meta` for `collect`, the incoming message otherwise. Validated as a `condition` against those shapes (`unresolved_pointer`, `shape_mismatch`).
- **`fail`.** Each component declares the codes it produces that a `try` can catch, listed by `components.list`: `http_fetch` `http_status`, `fetch_failed`, `fetch_timeout`, `body_too_large`; `parse_feed` `feed_invalid`; `host_llm` none. A case's unit fails at the step with that code and `message` (default `"Mocked failure."`), exactly as a real failure would. Warnings and errors from it carry `mocked: true`. `retry` is not exercised (spec decision 12).
- **`mock_unmatched`.** No case matches: the run fails with that kind, naming the step, the unit and the case count. `on_error: skip` does not skip it and no `try` catches it.
- **Validation:** `invalid_mock` for no or two outcomes in a case, a default case not last, more than 20 cases, a `fail.code` the component does not declare, `fail` on `host_llm`. The narrowing walk counts only `messages` cases.
- **Worked example** added as a second embedded test in `fixtures/pipelines/valid/feed-digest-filter.json`.
- **Spec updates:** [host-protocol](../../../specs/host-protocol.md) (`mock_unmatched` among the report-only error kinds), [composition](../../../specs/composition.md) (`mock_unmatched` among what `try` cannot catch; the test-harness section points to per-step `replies`), [agent-surface](../../../specs/agent-surface.md) and [pipeline-format](../../../specs/pipeline-format.md) (`cases`, `fail`).

**Blocked by:** [test-mocks-01](test-mocks-01-step-mocks.md). The `try` case below needs [composition-06](composition-06-unit-failures-try.md); whichever of the two lands second adds it.

**Verification:**
- **Behaviour:**
  - the spec's worked example passes: one warning of kind `http_status` with `mocked: true`, `fetch` and `parse` with `mocked: true`, `llm_requests[0].prompt` containing "Alpha a1" and "Alpha a2" but not "Beta b1";
  - the same test with `"contains": "Gamma"` in `summarize`'s case fails with `error_kind: "mock_unmatched"` naming `summarize`, also when `summarize` has no other case and `on_error: skip` sits on an earlier step;
  - a `parse` case matching no `meta:source_url` fails with `mock_unmatched` naming `parse`;
  - `fetch` without `on_error: skip` and with the failing case fails the run with `http_status` at `fetch`;
  - inside a `try` with a `catch` writing `/title` (once composition-06 exists): the note message has `meta:error_step` `fetch`, `meta:error_code` `http_status`, `meta:error_message` `503`.
- **Validation errors:**
  - a default case before another case, a case with both `messages` and `fail`, and 21 cases each give `invalid_mock`;
  - `fail.code: "quota_exhausted"` on `fetch` and any `fail` on `summarize` give `invalid_mock`;
  - `{ "field": "/title", "equals": "x" }` in a `fetch` case gives `unresolved_pointer`; `{ "field": "/url", "gt": 3 }` gives `shape_mismatch`;
  - a `parse` mock whose second case lacks `id` gives `mock_missing_field`; adding a `fail` case to it does not.
- **Regression:** every embedded test from test-mocks-01 passes unchanged.

**Status:** done 2026-11-03

- [x] `cases`, `when` views and their validation
- [x] Declared catchable codes (`failCodes` on components, `fail_codes` in `components.list`); `fail` through `on_error: skip`, `try` and plain failure
- [x] `mock_unmatched`; worked example as the second embedded test of `fixtures/pipelines/valid/feed-digest-filter.json`
- [x] Specs updated (host-protocol, composition, agent-surface, pipeline-format) and the tool description

The run process picks every case, `host_llm` included: it renders the prompt, evaluates `when` on `{ prompt, system? }` with the message's own `meta`, fails with `mock_unmatched` itself, and sends the chosen case index with the call; the harness answers from that case's replies. The supervisor passes the index on only in test runs. Tests: `tests/test-mocks-cases.test.ts`.
