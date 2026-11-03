# test-mocks-01: replace a step with fixed messages or replies

**Spec:** [test-mocks](../specs/test-mocks.md) (format, what a mocked step does, ids and metadata, interaction with the other test parameters, validation, run report), [agent-surface](../specs/agent-surface.md#pipeline-tests).

**To build:** unconditional mocks, the shorthand forms only: `{ "messages": […] }` on any processor step and `{ "replies": […] }` on `host_llm`. `cases`, `when` and `fail` come in test-mocks-02.
- **Schema.** `mocks` on `pipeline.test` params and on `tests[]` entries, keyed by processor step id. Ceilings (500 messages, 100 replies) reported by `components.list`.
- **Validation**, for embedded tests in `pipeline.validate` and `stream.create`/`stream.update` (paths `/tests/<i>/mocks/<id>/…`) and for `pipeline.test.mocks` before the run (paths `/mocks/<id>/…`):
  - `unknown_step`; `invalid_mock` for `replies` on a step that is not `host_llm`, `messages` on `host_llm`, or a ceiling exceeded;
  - `mock_shape_mismatch` for a field missing from the declared output shape or of the wrong kind, and for `meta.source_url` set on an `http_fetch` mock; `null` accepted for any scalar field;
  - the narrowing walk (spec decision 8): the mocked step's output shape is what every mock message carries, its own pointer checks are skipped, and an unresolved pointer downstream that the declared shape would resolve becomes `mock_missing_field` at the mock, naming the field and the reading step;
  - `changes_message_ids` for more than one message on an id-preserving step (spec decision 9);
  - `mock_unreachable` for a mock on a step inside a mocked container (spec decision 11).
- **Run process.** A mocked step does not run: no proxy, no fixture, no state, no host call. Per unit it emits its mock:
  - `http_fetch` once per URL, with `meta.source_url` set; `collect` once per batch; every other step, containers included, once per message;
  - ids as the real component numbers them; an id-preserving step keeps the incoming id;
  - `meta` is the incoming message's, overlaid with the mock's;
  - `host_llm` renders its prompt, records it in `llm_requests[]`, counts it against `llm_calls_per_run` before answering, and writes the next reply to `target`, the last repeating. `llm` does not answer a mocked step.
- **Report.** `steps[].mocked: true`, with `in`, `out`, `dropped`, `duration_ms` counting what the mock did. Additive to the report schema in `schemas/`.
- **Spec updates**, the parts of the spec's "Changes to other specs" this ticket covers: [agent-surface](../specs/agent-surface.md) (`mocks` in the parameter table and `tests[]`, `mocked` in reports, the fixture-authoring risk), [host-protocol](../specs/host-protocol.md) (`mocks` in `pipeline.test` params), [pipeline-format](../specs/pipeline-format.md) (`tests[].mocks`, the new validation codes).

**Blocked by:** nothing open. It uses nested steps and id preservation from [composition-03](completed/2026w45/composition-03-nested-steps-for-each.md).

**Verification:**
- **Behaviour**, on `fixtures/pipelines/valid/feed-digest-filter.json`:
  - `fetch` mocked with `[{ "data": {} }]`, `parse` mocked with entries a1, a2 (Alpha) and b1 (Beta), `summarize` mocked with `replies: ["The digest."]`: the test succeeds with one result "The digest."; `fetch` emitted 3 messages with `meta.source_url` set to the three URLs, and `parse` shows `in: 3, out: 9`, its mock once per incoming message; `llm_requests[0].prompt` contains "Alpha a1" but not "Beta b1"; `fetch` and `parse` show `mocked: true`;
  - the same run makes no connection to the proxy and reads no fixture, with `network: "mock"` and with `network: "live"`;
  - with `summarize` mocked and `llm.responses: ["other"]` also given, the result body is "The digest.";
  - with `llm_calls_per_run: 1` and two messages reaching a mocked `host_llm` (no `collect`), the run fails with `budget_exceeded` after one answered call;
  - a mocked `for_each` emits its mock per message and none of its nested steps appears with `invocations` above 0.
- **Validation errors:**
  - `fetchh` gives `unknown_step`; `replies` on `parse` and `messages` on `summarize` give `invalid_mock`;
  - a `parse` message without `id` gives `mock_missing_field` naming `/id` and `new_only`; `"score": 1` or `"title": 3` gives `mock_shape_mismatch`; `meta.source_url` in a `fetch` mock gives `mock_shape_mismatch`;
  - a `template` mock with two messages gives `changes_message_ids`;
  - mocks on both a `for_each` and a step inside it give `mock_unreachable`.
- **Regression:** `permissions_hash` is the same with and without `tests[].mocks`; every existing fixture and embedded test passes unchanged.

**Status:** open

- [ ] Schema, ceilings, `components.list`
- [ ] Validation codes and the narrowing walk
- [ ] Mocked steps in the run process; `host_llm` replies with budget and `llm_requests[]`
- [ ] Report `mocked`; specs updated
