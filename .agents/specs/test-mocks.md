# Test mocks: replace a step with fixed data, conditionally

Source: [test-mocks grilling record](../inbox/2026W45/test-mocks.md) (decisions 1–9, 2026-11-03), [agent-surface](agent-surface.md#pipeline-tests), [composition](composition.md) (the `condition` type and unit attribution), [ADR 003](../decisions/003-no-expression-language.md), Redpanda Connect unit testing (https://docs.redpanda.com/redpanda-connect/configuration/unit_testing/, read 2026-11-03; summarised in [Benthos research](../research/research-benthos.md) §7). Stage: **Design — spec; nothing implemented.**

## Scope

A `mocks` field on `pipeline.test` and on embedded `tests[]` entries. It replaces chosen processor steps with fixed output, chosen per unit by a `condition`, so an agent can test the part of a pipeline it cares about without writing feed XML or relying on the order of model calls.

Not in scope: a `mock` component in pipelines (decision 1); mocking inputs or outputs (decision 3; `input` and `results[]` already cover them); callbacks or computed replies (ADR 003); asserting how often a mock was used.

What already exists and stays: `inject`, `input`, `fixtures`, `network`, `llm`, `clock`, `state` ([agent-surface](agent-surface.md#pipeline-tests)). `fixtures` remain the way to test `http_fetch` and `parse_feed` themselves; `mocks` are the way to test what comes after them.

## Format

```json
"mocks": {
  "<step id>": { "messages": [ { "data": …, "meta"?: { … } } ] }
           | { "replies": [string] }
           | { "fail": { "code": string, "message"?: string } }
           | { "cases": [ { "when"?: condition, <exactly one of messages | replies | fail> } ] }
}
```

- The key is a processor step `id`. Inputs and outputs have no `id` and cannot be mocked.
- A mock without `cases` is shorthand for one case without `when`.
- `when` is a [`condition`](composition.md#condition). The first case whose `when` is true wins. A case without `when` matches everything and must be last.
- `replies` only on `host_llm`; on `host_llm`, only `replies` (proposal 3 below).
- `fail.code` must be a code the real component produces and a `try` can catch (decision 9). `message` defaults to `"Mocked failure."`.
- Ceilings, reported by `components.list` like the other compiled-in ceilings: at most 20 cases per mock, 500 messages per case (`parse_feed`'s own `max_entries`), 100 replies per case.

## Observable behaviour

### What a mocked step does

A mocked step does not run. Its config is still validated as part of the pipeline, but nothing it would do happens: no request through the proxy, no fixture lookup, no state read, no call to the host. For each **unit** (decision 8, following composition decision 13) the engine picks the first matching case and:

- `messages`: emits them as the step's output for that unit, as one emission of the real step would be.
- `replies` (`host_llm`): renders the prompt as the real step would, records it in `llm_requests[]`, counts it against `llm_calls_per_run` before answering, and writes the next reply of that case to `target`. Replies are answered in order within the case and the last one repeats.
- `fail`: the unit fails at this step with `code` and `message`, exactly as a real failure would. `on_error: skip` skips it with a warning, a `try` sends it to `catch` with `meta:error_step`, `meta:error_code` and `meta:error_message` set, and otherwise the run fails with that kind.
- No case matches: the run fails with `mock_unmatched`, naming the step, the unit and the case count. Like `fixture_missing` it is a mistake in the test, so no `try` catches it and `on_error: skip` does not skip it.

### What `when` sees

| Step | Unit | `when` evaluates against |
| --- | --- | --- |
| `http_fetch` | each URL of each incoming message | `{ "url" }` |
| `host_llm` | each incoming message | `{ "prompt", "system"? }`, as the host would receive them |
| `collect` | the incoming batch | `{ "items", "count" }` built from the batch, `meta` of its first message |
| any other step, containers included | each incoming message | the message's `data` and `meta` |

`meta:` fields in `when` read the incoming message's metadata in every row.

### Ids and metadata

- A mocked step keeps its component's id rule. A step that does not preserve ids numbers what it emits as the real step would (`<id>.<n>`). A step that preserves ids may emit zero or one message per unit; one keeps the incoming id (proposal 2).
- A mocked `http_fetch` sets `meta.source_url` to the unit's URL on every message it emits, because that is the unit's identity, not data from the network. A mock that sets `meta.source_url` itself fails validation with `mock_shape_mismatch`.
- Otherwise `meta` of an emitted message is the incoming message's `meta` overlaid with the mock's `meta`.

### Interaction with the other test parameters

- A mocked `host_llm` is never answered by `llm`. Unmocked `host_llm` steps are answered by `llm` as today.
- A mocked `http_fetch` ignores `fixtures` and `network`, including `network: "live"`. Unmocked fetches behave as today.
- `retry` on a mocked step is not exercised: `fail` is final for that unit (proposal 5). Retry is tested with `fixtures`.
- The composition harness clamp stays: replies are given in order within a case, so concurrency is still clamped to 1 under `pipeline.test`.

## Validation

Mocks are validated with the pipeline: embedded `tests[].mocks` by `pipeline.validate` and `stream.create`/`stream.update` (paths `/tests/<i>/mocks/<id>/…`), and `pipeline.test.mocks` before the run (paths `/mocks/<id>/…`), as the same issue list as pipeline errors.

**Shape (decision 6, implemented by proposal 1).** For each test, the validator walks the pipeline again with each mocked step's output shape replaced by the shape its mock emits:

- Every field in a mock message must exist in the step's declared output shape with a matching kind, otherwise `mock_shape_mismatch`. `null` is accepted for any scalar field (open point 1).
- The emitted shape is the declared shape restricted to the fields that every message of every `messages` case carries. `fail` cases emit nothing and are not counted. A `replies` mock writes a string to `target`, as the real step does.
- Steps after the mock are checked against that shape. A pointer that the declared shape would resolve and the mock's shape does not gives `mock_missing_field` at the mock, naming the field and the step that reads it. A read of a whole value (`{{/items}}`, `collect`) requires only that path.
- The mocked step's own pointer checks are skipped, since it does not read its input. That is why `{ "data": {} }` is a valid mock for an `http_fetch` whose `parse_feed` is also mocked.

**Other codes:**

| Code | When |
| --- | --- |
| `unknown_step` | the key is not a processor step id in the pipeline |
| `mock_unreachable` | the step sits inside a container that is itself mocked (proposal 4) |
| `invalid_mock` | structure: no or two outcomes in a case, a default case not last, `replies` on a step that is not `host_llm`, `messages` or `fail` on `host_llm`, a ceiling exceeded, a `fail.code` the component cannot produce |
| `changes_message_ids` | an id-preserving step's case emits more than one message (the code from composition) |
| `mock_shape_mismatch`, `mock_missing_field` | as above |

`when` is checked as a `condition` against the row's view: `{ "url" }` and `{ "prompt", "system" }` are known shapes, so `{ "field": "/title", "equals": … }` on an `http_fetch` mock gives `unresolved_pointer`.

## Run report and test result

- A mocked step's `steps[]` entry has `mocked: true`. Its `in`, `out`, `dropped` and `duration_ms` count what the mock did.
- A warning or error caused by a `fail` case carries `mocked: true` in its extras.
- `llm_requests[]` includes prompts answered by mocks, as today.
- Embedded test `expect.error_kind: "mock_unmatched"` works without change.

All additions are additive to the report schema.

## Permissions

None. Mocks live in tests, permissions are derived from the pipeline's components, and tests never run in a stream. Adding, changing or removing `tests[].mocks` leaves `permissions_hash` unchanged and never needs approval.

## Changes to other specs

These land with the tickets, in the same commit:

1. **[agent-surface](agent-surface.md)**: `mocks` in the `pipeline.test` parameter table and in `tests[]`; `mocked` in reports; the fixture-authoring risk names `mocks` as the mitigation.
2. **[host-protocol](host-protocol.md)**: `pipeline.test` params gain `mocks`; `mock_unmatched` joins the report-only error kinds.
3. **[pipeline-format](pipeline-format.md)**: `tests[]` gains `mocks`; the validation codes above.
4. **[composition](composition.md)**: `mock_unmatched` joins what `try` cannot catch; the test-harness section points to per-step `replies`; mocking containers (proposal 4) once nested steps exist.

## Worked example

`fixtures/pipelines/valid/feed-digest-filter.json` (fetch three feeds, parse, dedupe, keep titles with "alpha", collect, template, one model call). Feed a has two Alpha posts, feed b one Beta post, feed c returns 503:

```json
{
  "name": "one feed down, alpha posts summarised",
  "mocks": {
    "fetch": {
      "cases": [
        { "when": { "field": "/url", "equals": "https://news.example.net/atom.xml" },
          "fail": { "code": "http_status", "message": "503" } },
        { "messages": [ { "data": {} } ] }
      ]
    },
    "parse": {
      "cases": [
        { "when": { "field": "meta:source_url", "equals": "https://example.com/feed.xml" },
          "messages": [
            { "data": { "id": "a1", "title": "Alpha a1", "link": "https://example.com/a1" } },
            { "data": { "id": "a2", "title": "Alpha a2", "link": "https://example.com/a2" } }
          ] },
        { "when": { "field": "meta:source_url", "equals": "https://blog.example.org/rss" },
          "messages": [ { "data": { "id": "b1", "title": "Beta b1", "link": "https://blog.example.org/b1" } } ] }
      ]
    },
    "summarize": {
      "cases": [ { "when": { "field": "/prompt", "contains": "Alpha a2" }, "replies": ["The digest."] } ]
    }
  },
  "expect": { "status": "succeeded", "results_count": 1, "result_body_contains": ["The digest."], "warnings_count": 1 }
}
```

- `fetch` makes no request. URL c fails with `http_status`; `fetch` has `on_error: skip`, so the report has one warning with `mocked: true`. URLs a and b each emit one message with `meta.source_url` set.
- `parse` picks its entries by `meta:source_url`. `dedupe` runs against empty state; `filter` drops "Beta b1"; `collect` and `template` run for real.
- `summarize` matches on the rendered prompt and counts one call of `llm_calls_per_run: 1`. A prompt without "Alpha a2" would fail the test with `mock_unmatched`.
- Validation: `new_only` reads `/id` and `topic` reads `/title`, both present in every `parse` message, so the test is valid. Dropping `id` from one message gives `mock_missing_field` at `/tests/<i>/mocks/parse`, naming `/id` and `new_only`.

## Decisions and reasons

Inherited from the grilling record:

1. **Mocks belong to tests, keyed by step id** (decision 1). The pipeline that runs contains nothing test-only, and permissions come from it alone.
2. **A mock emits fixed messages per unit and is checked against the declared shape** (decisions 2, 6, 8). Requiring only the fields downstream reads keeps mocks short without losing the check before the run.
3. **Any processor step can be mocked, inputs and outputs cannot** (decision 3).
4. **`host_llm` is mocked per step with `replies`** (decision 4), and still counts against the call limit, so a test still catches a pipeline that would exceed it.
5. **`cases` with `when`, first match wins, unmatched fails** (decision 7). Strict, because a silent default hides mistakes in the test.
6. **`fail` is limited to catchable codes the real component produces** (decision 9), so a mock cannot simulate a failure the pipeline could never see.
7. **No callbacks** (ADR 003).

Proposed while writing this spec; **not yet accepted by Hong**:

1. **Decision 6 is implemented by narrowing the shape, not by an index of reads.** The validator already checks every pointer against the shape at each step; replacing the mocked step's output shape and walking again gives "required = what downstream reads" with no new machinery. An unresolved pointer that only the mock causes is reported as `mock_missing_field` at the mock, since that is what the agent must change.
2. **A mock cannot change whether a step preserves ids.** An id-preserving step's case emits zero or one message. Otherwise a mocked step inside a `while` body or a `workflow` branch would break composition decision 16 in the test only.
3. **`host_llm` is mocked only through `replies`.** `messages` or `fail` there would skip prompt rendering, `llm_requests[]` and the call count, which are what a test of a model step is for. Decision 7 allowed `messages` on any step; this narrows it for `host_llm`.
4. **Mocking a container replaces all of it.** Its steps do not run, and a mock on a step inside it is `mock_unreachable` rather than silently ignored. `collect`'s unit is its batch, which `when` sees as `{ items, count }`.
5. **`fail` is final; `retry` is not exercised on a mocked step.** Simulating attempts would need a per-attempt outcome list, which is more format for a behaviour `fixtures` already test.

## Risks

- **Mocks can drift from what the real step emits.** The shape check catches missing or extra fields, not realistic values: a mocked `published` of `"yesterday"` passes as a string. Embedded tests that use only mocks never exercise `parse_feed`; keep at least one fixture-based test per pipeline that has `http_fetch`. Whether to warn when a pipeline's tests mock every `http_fetch` and `parse_feed` is open point 2.
- **`when` on a rendered prompt couples a test to template wording.** That is intended for "the prompt contains the feed titles", but a reworded template fails tests that only meant to supply a reply. Agents should use a case without `when` when they do not mean to assert on the prompt.
- **The ceilings (20 cases, 500 messages, 100 replies) are guesses.** They bound document size; revisit with real tests.

## Acceptance criteria

- The worked example passes. The report shows `fetch` and `parse` with `mocked: true`, one warning with kind `http_status` and `mocked: true`, and `llm_requests[0].prompt` containing "Alpha a1" and "Alpha a2" but not "Beta b1".
- The same test with `"contains": "Gamma"` in `summarize`'s case fails with `error_kind: "mock_unmatched"`, naming `summarize`.
- The worked example makes no connection to the proxy and reads no fixture, even with `network: "live"`.
- `parse` mocked without `id` in one message fails validation with `mock_missing_field` at `/tests/0/mocks/parse`, naming `/id` and `new_only`. A message carrying `"score": 1`, or `"title": 3`, fails with `mock_shape_mismatch`.
- A mock keyed `fetchh` fails with `unknown_step`. `replies` on `parse` and `messages` on `summarize` each fail with `invalid_mock`. `fail.code: "quota_exhausted"` on `fetch` fails with `invalid_mock`.
- A mocked `template` case with two messages fails with `changes_message_ids`.
- With `summarize` mocked and `llm.responses: ["other"]` also given, the result body is the mock's reply.
- `llm_calls_per_run: 1` with two messages reaching a mocked `host_llm` fails with `budget_exceeded` after one answered call.
- A pipeline's `permissions_hash` is the same with and without `tests[].mocks`.
- Every existing test fixture and embedded test passes unchanged.

## Open points

1. **`null` in mocks.** `Shape` has no nullability, and `parse_feed` emits `published: null`. This spec accepts `null` for any scalar field. The stricter alternative is to declare nullability per field in each component's output shape.
2. **Warn when tests mock all I/O?** A pipeline whose every test mocks every `http_fetch` and `parse_feed` never tests parsing real feeds. A validation warning would say so; it would also fire on pipelines whose author has a good reason.
3. **Unused cases.** A case that never matched in a passing test may be a typo in `when`. Reporting it needs a new field in the test result; a warning would break `warnings_count` expectations.
4. **`url_not_allowed` as a `fail` code.** Real `http_fetch` with `on_error: skip` skips it (a redirect to a host outside the allowlist), but decision 9 did not list it.
