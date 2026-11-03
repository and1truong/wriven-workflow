# Composition: conditions, routing, loops, recovery

Source: [composition grilling record](../inbox/2026W45/composition-components.md) (decisions 1–16, 2026-11-03), [ADR 003](../decisions/003-no-expression-language.md), [ADR 006](../decisions/006-delivery-single-ack-strict-idempotent.md), [ADR 008](../decisions/008-mandatory-limits.md), [Benthos research](../research/research-benthos.md) and the Redpanda Connect pages listed in the grilling record (read 2026-11-03). Stage: **Design — spec; nothing implemented. Post-v0.**

## Scope

The components added after v0 for composing steps, and the one shared type they use:

- `condition`, a declarative boolean type. It is not a component.
- `filter`, `switch`, `split`, `try` (with `catch`), `for_each`, `while`, `workflow`, `sleep`, `log`.

For each one this spec gives its configuration, how it moves messages and batches, its errors, what validation checks, what permissions it contributes, and what the run report and test harness show. It also lists the changes these components force on the existing specs; those specs are updated when the tickets land, not before.

Out of scope, by decision: `jq`, `mapping`, `metrics`, and a `retry` wrapper (grilling decisions 1, 2, 12). Retry stays a field on components that do I/O, with the shape it has today on `http_fetch` and `host_result`. A component added later that does I/O gets the same field. `host_llm` never gets one.

## Who writes this

The pipeline author is an agent, never a person (grilling round 2). Names, defaults and error messages are chosen for an agent that reads `components.list` and learns from validation errors. The person still reads the permission sentences at approval, so anything with consequences still renders as English. Nothing in this spec adds a consequence that lacks a sentence.

## Observable behaviour

- Container components (`switch`, `try`, `for_each`, `while`, `workflow`) hold lists of steps under named fields. A nested step looks exactly like a top-level processor: it has an `id`, a `type` and that component's fields.
- Step `id`s are unique across the whole pipeline, nested steps included. Run reports, typed errors, idempotency keys, test mocks and `dedupe` state all key on `id`.
- Nesting depth is at most 4 containers, and a pipeline has at most 64 steps in total. Both are compiled-in ceilings reported by `components.list`, like the limits in ADR 008.
- No nested step can do anything a top-level step cannot. Permissions are derived by walking the whole tree.
- Validation stays total. Shapes flow through nested steps. Every rule below that can be checked before running is checked before running.

## Message identity

Some rules below depend on whether a step keeps message `id`s. Every component declares whether it **preserves ids**: each output message carries the `id` of an input message, and no output is created from nothing.

| Preserves ids | Does not |
| --- | --- |
| `template`, `host_llm`, `dedupe`, `filter`, `sleep`, `log` | `http_fetch` (`<id>.<n>` per URL), `parse_feed` (`<id>.<n>` per entry), `split` (`<id>.<n>` per element), `collect` (`<first id>.c`) |

A container preserves ids when every step list inside it does. Two places require it: the body of a `while` and the steps of a `workflow` branch (validation code `changes_message_ids`). A container whose steps preserve ids returns its messages in input order. Otherwise it returns them in the group order its own section states.

## `condition`

A JSON object, used by `filter.keep_if`, `switch.cases[].when` and `while.repeat_while`.

**Leaf**: `{ "field": <reference>, <operator>: <value> }`. `field` is a JSON Pointer into `data`, or `meta:<key>`. Exactly one operator, plus `case: "insensitive"` on the string operators.

| Operator | Value | True when |
| --- | --- | --- |
| `equals` | string, number, boolean or null | the field equals the value (no deep equality on objects or arrays) |
| `in` | array of scalars (1–100) | the field equals one of them |
| `contains` | string or scalar | a string field contains the value as a substring, or an array field has an element equal to it |
| `contains_any` | array of strings (1–100) | a string field contains any of them; for keyword lists, which agents write often |
| `starts_with` | string | a string field starts with the value |
| `exists` | boolean | `true`: the field resolves; `false`: it does not |
| `gt`, `gte`, `lt`, `lte` | number | a number field compares so |
| `newer_than`, `older_than` | duration (`24h`, `7d`) | an RFC 3339 string field is within, or before, that duration of the run's clock (the fake clock in tests) |

**Combinators**: `{ "all": [conditions] }`, `{ "any": [conditions] }`, `{ "not": condition }`. At most 4 levels deep and 32 leaves.

**Missing fields.** A leaf whose field does not resolve is false, except `exists: false`, which is true. `not` inverts that, so `{ "not": { "field": "/title", "contains": "ad" } }` is true for a message with no `/title`. `components.list` says this in its `condition` entry, which documents every operator.

**Null.** A null value counts as no value: only `equals: null` and `in` with `null` can be true of it, and `exists: true` holds. Feeds often have `published: null`, and a run should not fail over that.

**Types.** When the upstream shape is known, validation checks that the operator fits the field (`gt` on a string field gives `shape_mismatch`) and that the field can resolve (`unresolved_pointer`, except under `exists`). When the shape is unknown, a mismatch at run time is a processor error, code `condition_type_mismatch`, which a `try` can catch.

**No regex** (grilling decision 10). JavaScript's RegExp backtracks, so an agent-written pattern can hang a run (ReDoS). A linear-time engine would be a new dependency.

Conditions carry no permission. They decide which messages go where inside the run; nothing they decide leaves the machine on its own.

## Components

### `filter`

`{ "id", "type": "filter", "keep_if": condition }`. Keeps the messages for which the condition is true and drops the rest. A drop is a deliberate acknowledgement, as with `dedupe`. Preserves ids. An empty batch afterwards behaves as it does after `dedupe`. Report: `dropped` counts the messages filtered out.

### `switch`

```json
{ "id": "route", "type": "switch",
  "cases": [ { "when": condition, "steps": [ ... ] }, ... ],
  "default": [ ... ] }
```

- Each message goes to the first case whose `when` is true. There is no fallthrough and no `continue`: Redpanda Connect has both, and they invite mistakes.
- Messages that match no case go to `default`. Without `default` they pass through unchanged.
- `cases`: 1–16 entries. `steps` may be empty, which passes the matching messages through.
- Each case's steps run once, on the batch of messages routed to it, so a `collect` inside a case collects that case's messages.
- Output is one batch. When every case and `default` preserve ids, it is in input order. Otherwise the order is case 1's output, case 2's, and so on, then `default`'s output, then the unmatched messages.
- Shape after `switch`: the shapes of all branches merged (see [Shape merging](#shape-merging)).

### `split`

`{ "id", "type": "split", "field": <pointer>, "max_items": 100 }`. The field must hold an array. Each element becomes a message whose `data` is the element, with the parent's `meta` copied. Ids are `<id>.<n>`, the scheme `parse_feed` uses.

- An empty array drops the message, deliberately.
- A field that is not an array is a processor error.
- `max_items` defaults to 100, at most 1,000. Extra elements are dropped with a warning, as in `collect`.

This is the inverse of `collect`: a model that returns a JSON list (after a parsing step) becomes one message per item.

### `try`

```json
{ "id": "sources", "type": "try", "steps": [ ... ], "catch": [ ... ] }
```

- `steps` run on the batch as usual. When a step fails for a **unit**, that unit leaves `steps` and goes to `catch`. All other units continue through `steps`.
- **Unit.** The unit is the smallest thing the failing component processes on its own:
  - for `http_fetch`, one URL of one message, carried as a message with the id that URL's output would have had (`<id>.<n>`), the input `data`, and the input `meta` plus `source_url`;
  - for every other v0 component, one input message.
  - A new component states its unit in its own spec.
- **Catch receives** the unit as it was when the failing step received it, with three metadata keys set: `error_step` (the failing step's id), `error_code` and `error_message`. Anything else the unit produced inside `steps` is discarded.
- **Output.** The output of `steps`, followed by the output of `catch`, as one batch. Shape: the two merged. `catch` itself validates against the merge of the shapes the top-level steps of `steps` receive, since a unit fails at one of them; when `steps` holds a container, against `unknown`.
- **`catch` missing.** A failure fails the run, so `try` without `catch` only groups steps. **`catch: []`**: the failed units are dropped, deliberately.
- **What can be caught**: the failures `on_error: skip` can skip today, generalised to every component. That is, processor errors attributable to one unit: fetch failures, `permission_denied` on a redirect, feed parse errors, `unresolved_pointer`, `condition_type_mismatch`, a non-array at `split`.
- **What cannot be caught**: typed errors from the host at `host_llm` or `host_result`, `budget_exceeded`, `timed_out`, `memory_limit`, `cancelled`, `fixture_missing` (a mistake in the test, as `http_fetch` already treats it) and `internal`. These end the run as before. Otherwise `catch` would be a back door around "no retry, no fallback by default".
- **Failures inside `catch`** follow the normal rules, so they fail the run unless a `try` nested in the `catch` handles them.
- **Every caught failure is also a warning** in the run report (`{ step, message_id, code, message }`, code as raised, plus `"caught_by": "<try id>"`), so recovery never hides a failure from the report.
- **`on_error: skip`** on `http_fetch` and `parse_feed` stays valid in format `@1` and means exactly a `try` with `catch: []` around that one step.

### `for_each`

`{ "id", "type": "for_each", "steps": [ ... ], "concurrency": 1 }`. Runs `steps` on each message as a batch of one.

- `concurrency` defaults to 1 and is at most 8. Redpanda Connect calls this field `cap` on `parallel`; this spec names it for what it does.
- Output is the concatenation of each message's output in input order, whatever order they finish in.
- The first failure that no `try` catches fails the run and aborts the other messages still in flight.
- Use it for concurrency, and to make a batch-level step (`collect`, `dedupe`) see one message at a time. Validation warns `per_message_context` when `collect` sits directly inside `for_each`, since it would collect one item.
- `host_llm` inside `for_each` sends calls concurrently, up to the smaller of `concurrency` and the host's `llm_concurrency` (see [Changes to other specs](#changes-to-other-specs)). Every call still counts against `llm_calls_per_run` before it is sent. The count is reserved before sending, so concurrent calls cannot overshoot it.

### `while`

```json
{ "id": "until_valid", "type": "while",
  "repeat_while": condition, "steps": [ ... ],
  "max_loops": 3, "at_least_once": false, "on_limit": "fail" }
```

- `max_loops` is required, 1–20. Redpanda Connect defaults to 0, which means unbounded; grilling decision 5 rules that out.
- Each iteration checks the condition for each message still in the loop. Messages for which it is false leave the loop. The rest go through `steps` together as one batch. With `at_least_once: true`, the first iteration skips the check.
- `steps` must preserve ids (`changes_message_ids` otherwise). A message dropped inside the body (by a `filter`) leaves the loop and the batch, deliberately.
- When `max_loops` is reached with messages still in the loop:
  - `on_limit: "fail"` (default) fails the run with `loop_limit`. A loop that did not reach its goal is a failure, consistent with strict errors.
  - `on_limit: "continue"` lets those messages leave as they are, with a warning `loop_limit` per message. Use it for pagination.
- Output is in input order.
- Idempotency: inside a `while`, the `host_llm` key gains the iteration (see [Changes to other specs](#changes-to-other-specs)). Otherwise iteration 2 would reuse iteration 1's key with a different prompt, and the host would return the stored reply, so the loop would never progress.

### `workflow`

```json
{ "id": "enrich", "type": "workflow",
  "branches": [
    { "id": "classify", "steps": [ ... ], "result": "/category", "target": "/category" },
    { "id": "translate", "steps": [ ... ], "result": "/vi", "target": "/translation" },
    { "id": "headline", "after": ["classify"], "steps": [ ... ], "result": "/headline", "target": "/headline" }
  ] }
```

Here `classify` and `translate` run concurrently. `headline` runs after `classify`, so its steps can read `/category`.

Each branch builds a child message per parent message and runs its steps on the batch of children. It then writes a value from each child back into its parent.

**Fields of a branch:**

- `id`, unique pipeline-wide like any step id.
- `from`: a pointer into the parent's `data`; its value becomes the child's `data`. Default is a copy of the whole `data`. Either way, the child is built from the parent as it is when the branch starts, after its dependencies have written their targets. The child copies `meta` and keeps the parent's `id`.
- `steps`: must preserve ids.
- `result`: a pointer into the child's `data` after the steps. Default is the root.
- `target`: required; where in the parent the result is written.
- `after`: branch ids that must finish first.

**Dependencies.** Branch B depends on branch A when B has an explicit `from` and either B's `from` is a prefix of A's `target` or A's `target` is a prefix of B's `from`, or when B lists A in `after`. A branch without `from` gets no inferred dependencies; otherwise the whole-data default would make every branch depend on every other. A branch that wants a sibling's result names it in `from` or `after`. If its steps read a sibling's target without doing so, validation reports `unresolved_pointer`: the shape it validates against is the parent at the start of the `workflow` plus only the targets of its dependencies. Because references are pointers, the dependency is exact, not Redpanda Connect's "best attempt" (grilling decision 6). A cycle fails validation (`cycle`). Two branches whose targets overlap fail validation (`write_conflict`). Branches with no path between them run concurrently. Their `host_llm` calls share the host's `llm_concurrency`.

**Skips.** A parent whose `from` does not resolve, or whose child was dropped inside the branch (by a `filter`), is skipped for that branch: its `target` is not written. A dependent branch then finds its own `from` missing and skips too. Skips are counted per branch in the report. They are not warnings, because skipping is how an agent writes "only translate items that were classified as news".

**Failures** follow the normal rules. Wrap the branch's steps in a `try` to recover.

**Output and shape.** Output is the parent batch in input order, with every written target. Each target's shape is inferred from the branch's own steps, so pointers after a `workflow` validate as usual. 1–16 branches.

### `sleep`

`{ "id", "type": "sleep", "duration": "10s" }`, from 1s to 5m.

- It waits once per batch it receives, so inside `for_each` it waits once per message. Cancellation interrupts it.
- Under `pipeline.test` it advances the fake clock instead of waiting.
- Validation: along any single path through the pipeline, the sum of `sleep` durations, each multiplied by the `max_loops` of every enclosing `while`, must be below `run_timeout` (`sleep_exceeds_timeout`). This bounds one pass of one message. A batch inside `for_each` with `concurrency: 1` can still sleep longer in total, and `run_timeout` stops it.
- No permission.

### `log`

`{ "id", "type": "log", "text": "Kept {{/title}}" }`.

- Appends `{ step_id, message_id, text }` to a new `logs` array in the run report for each message passing through.
- `text` is at most 500 characters, with the same placeholders as `template` and `missing: "empty"` always on, because a log line must never fail a run.
- At most 100 entries per run. After that, one warning `logs_truncated` and no more entries.
- `pipeline.test` returns `logs` too. This is the agent's `print`.
- No permission: the report goes to the host, which already receives everything.

## Shape merging

When two step lists feed one output (`switch` branches, `try` steps and catch), the output shape is their merge. Objects merge key by key. A key present in only one side becomes `unknown`. Differing kinds become `unknown`. A pointer into an `unknown` part is checked at run time, as it is today for unknown shapes. An agent keeps validation strong by making `catch` and each case write the same fields as the main path.

## Permissions

New fields in the permissions object. Zero values are excluded from canonical form, so existing hashes are unchanged:

| Field | Set when | Sentence |
| --- | --- | --- |
| `skips_failed_items: true` | any `try` has `catch: []` | "Skips an item that fails at a step, and says so in the run report." |
| `handles_failed_items: true` | any `try` has a non-empty `catch` | "When an item fails at a step, handles it with fallback steps instead of stopping, and says so in the run report." |

Subset rule: each may go from true to false without approval, not from false to true.

Every nested step contributes what it would contribute at top level. One change, for `host_llm.receives_fetched_content`: "an `http_fetch` precedes it" becomes "an `http_fetch` appears earlier in document order, or anywhere in the same `while` body, or in any branch of the same `workflow`". This over-approximates, which is the safe direction. A linear v0 pipeline gets the same result as before.

`filter`, `switch`, `split`, `for_each`, `while`, `workflow`, `sleep`, `log` and `condition` contribute nothing.

## Run report

- `steps[]` stays flat. A nested step's entry gains `parent` (the container's id) and `invocations` (how many times it ran). Its `in`, `out`, `dropped` and `duration_ms` are summed over invocations.
- A `workflow` branch reports `skipped`.
- New top-level `logs[]`.
- New warning codes: `loop_limit`, `logs_truncated`, `per_message_context` (validation only). Caught failures appear as warnings with `caught_by`.

All additions are additive to the report schema.

## Test harness

- `llm.mode: "mock"` answers in call order. Concurrency would make that order nondeterministic, so under `pipeline.test` every `concurrency` and the workflow branch concurrency are clamped to 1, and the result says so in a field `clamped: ["for_each:<id>", ...]`. Concurrency itself is covered by the engine's own tests against the fake host.
- `sleep` advances the fake clock.
- Embedded test `expect` gains `logs_contain?: [string]`.

## Changes to other specs

These land with the tickets that build each component, in the same commit:

1. **[pipeline-format](pipeline-format.md)**:
   - list the new components;
   - step ids unique pipeline-wide;
   - the nesting and step-count ceilings;
   - new validation codes `changes_message_ids`, `cycle`, `write_conflict`, `sleep_exceeds_timeout`, `nesting_too_deep`, `too_many_steps`, `duplicate_id`.
2. **[delivery-semantics](delivery-semantics.md)**:
   - `host.llm` key becomes `"<run_id>/<step_id>@<iterations>/<message_id>"` inside a `while`, where `<iterations>` is the 1-based iteration of each enclosing `while`, outermost first, joined by `.`. Outside any `while` it stays `"<run_id>/<step_id>/<message_id>"`, so v0 keys are unchanged. Hosts treat the key as opaque, so they need no change.
   - Decision 6 (sequential `host.llm`) becomes "at most `llm_concurrency` outstanding `host.llm` requests per run".
   - `try` replaces "there is no `catch` to route to" in the errors section, and `on_error: skip` is described as its sugar.
3. **[host-protocol](host-protocol.md)**: `initialize` gains an optional host capability `llm_concurrency` (integer, default 1, at most 8). A host that does not send it keeps today's guarantee of one call at a time. The conformance kit gains a case with two concurrent calls.
4. **[permissions](permissions.md)**: the two new fields, their sentences, their subset rule, and the `receives_fetched_content` rule above.
5. **[agent-surface](agent-surface.md)**: `logs` and `clamped` in `pipeline.test` results; `logs_contain` in embedded tests.

## Worked example

Fetch three feeds, keep new items about Rust or Zig, note any feed that could not be read, classify items concurrently, and send one digest:

```json
"processors": [
  { "id": "sources", "type": "try",
    "steps": [
      { "id": "fetch", "type": "http_fetch", "urls": ["https://a.example/feed", "https://b.example/rss", "https://c.example/atom"] },
      { "id": "parse", "type": "parse_feed" },
      { "id": "new_only", "type": "dedupe", "key": "/id", "remember": "90d" },
      { "id": "topic", "type": "filter",
        "keep_if": { "field": "/title", "contains_any": ["rust", "zig"], "case": "insensitive" } }
    ],
    "catch": [
      { "id": "failure_note", "type": "template", "target": "/title",
        "text": "Could not read {{meta:source_url}} today: {{meta:error_message}}" }
    ] },
  { "id": "classify_each", "type": "for_each", "concurrency": 4,
    "steps": [
      { "id": "classify_prompt", "type": "template", "target": "/prompt", "missing": "empty",
        "text": "One word, news or tutorial: {{/title}} {{/summary}}" },
      { "id": "classify", "type": "host_llm", "prompt": "/prompt", "target": "/kind" }
    ] },
  { "id": "gather", "type": "collect", "min_items": 1, "max_items": 50 },
  { "id": "prompt", "type": "template", "target": "/prompt",
    "text": "Write a digest grouped by /kind. Mention unreadable feeds at the end.\n\n{{/items}}" },
  { "id": "summarize", "type": "host_llm", "prompt": "/prompt", "target": "/summary" }
]
```

With `limits.llm_calls_per_run: 31`. Classification happens before `collect`, so `max_items: 50` does not bound it. A day with more than 30 messages reaching `classify_each` runs out of calls before the digest and fails with `budget_exceeded`, and the run report says so. Failure notes count too, since they pass through `classify_each` like entries. `take` (tier 2) is what would let the agent bound it in the pipeline itself. The permissions render as the v0 example's, with "Skips a source that cannot be fetched or read that day…" replaced by "When an item fails at a step, handles it with fallback steps instead of stopping, and says so in the run report." and with "at most 31 requests per run".

## Decisions and reasons

Inherited from the grilling record:

1. **No expression language anywhere** (decision 1, ADR 003). `condition` is a boolean tree over pointers with fixed operators. It cannot compute, loop or call.
2. **`catch` lives inside `try`** (decision 3), with the error in three fixed metadata keys, the uncatchable list above, and every caught failure in the report.
3. **`for_each` carries concurrency** (decision 4); calls still count against the limit before sending.
4. **`while.max_loops` is required** (decision 5).
5. **`workflow` dependencies are exact**, from pointers (decision 6).
6. **`sleep` is bounded by `run_timeout` at validation** (decision 7); **`log` writes to the run report** (decision 8).
7. **`condition` comes first, regex excluded, missing field is false** (decision 10). **`filter`, `switch`, `split` exist** (decision 11). **Retry is a per-component field** (decision 12).

Proposed while writing this spec and accepted by Hong in round 3 of the grilling record (decisions 13–16, 2026-11-03):

8. **Failures in a `try` are attributed to units, and `catch` gets the unit as the failing step saw it.** Without this, three URLs in one `http_fetch` share one trigger message, and one bad feed would send all three to `catch`. That would defeat the use case that justified `catch` in decision 3.
9. **`on_error: skip` becomes sugar for `try` with `catch: []`.** One mechanism, two spellings. Format `@1` documents stay valid.
10. **Concurrent `host.llm`, opt-in by the host through `llm_concurrency`.** Decision 4 wants concurrency because sequential calls are slow. Delivery-semantics decision 6 promised the host one call at a time. A capability defaulting to 1 keeps that promise for every host that does not ask for more.
11. **The id-preserving rule** for `while` bodies and `workflow` branches. It makes write-back and loop membership checkable before the run, and it gives input order back wherever ids survive.

## Risks

- **Container semantics are where agents will make mistakes**: a `collect` inside `for_each`, a `not` over a missing field, an unmatched message passing through a `switch` with no `default`. The mitigations are validation warnings and `components.list` descriptions that state each trap in one sentence. Watch real agent pipelines and add warnings where agents trip.
- **Shape merging weakens validation** after `switch` and `try` when branches write different fields. Agents learn this from run-time `unresolved_pointer` errors, which is later than ideal.
- **Unit attribution needs every component to report per-unit failures** instead of throwing on the first failure. `http_fetch` and `parse_feed` already work this way for `on_error: skip`; the other four v0 processors need the same refactor.
- **Concurrent `host.llm` is new load on the host.** The capability keeps it opt-in, but a host that sets it must handle concurrent idempotent calls correctly. The conformance case exists for this.
- **The step-count ceiling (64) and nesting ceiling (4) are guesses.** Revisit with real pipelines.

## Acceptance criteria

- A `filter` with `{ "field": "/title", "contains_any": ["rust"], "case": "insensitive" }` over injected titles "Rust 2.0", "Go news" and a message with no `/title` keeps exactly the first. `dropped: 2` appears in the report.
- `{ "field": "/title", "gt": 3 }` against `parse_feed` output fails validation with `shape_mismatch` at the condition's path.
- A `switch` with two id-preserving cases returns messages in input order. With a `collect` in case 1, it returns case 1's collected message first, then case 2's messages.
- **`try` around `http_fetch` (three fixture URLs, one returning 503) and `parse_feed`:**
  - with `catch` writing `/title`, the run succeeds; the output holds the two feeds' entries followed by one note message whose `meta.error_step` is `fetch` and `meta.source_url` is the failing URL; the report has one warning with `caught_by: "sources"`; permissions include the "handles it with fallback steps" sentence;
  - with `catch: []`, the run succeeds without the note, and the "Skips an item" sentence replaces it;
  - with no `catch`, the run fails with step `fetch`.
- A `host_llm` failure with `quota_exhausted` inside a `try` fails the run; `catch` does not run.
- `for_each` with `concurrency: 4` over 8 messages, run against the fake host with `llm_concurrency: 4`, has at most 4 outstanding `host.llm` requests, returns outputs in input order, and makes exactly 8 calls. With `llm_calls_per_run: 5`, the run fails with `budget_exceeded` after exactly 5 calls were sent.
- The same pipeline under `pipeline.test` reports `clamped: ["for_each:<id>"]` and gives mock responses in input order.
- A `while` with `max_loops: 3` around `host_llm`, whose mock replies never satisfy the condition, makes 3 calls with keys `…/<step>@1/<msg>`, `…@2/…` and `…@3/…`, then fails with `loop_limit`. With `on_limit: "continue"` it succeeds with one `loop_limit` warning per message.
- A `while` whose body contains `split` fails validation with `changes_message_ids`.
- A `workflow` where branch B's `from` is A's `target` runs A before B. Adding `after: ["B"]` to A fails validation with `cycle`. Two branches with targets `/a` and `/a/b` fail with `write_conflict`.
- A `workflow` branch with a `filter` that drops one parent leaves that parent's `target` unwritten. A dependent branch skips it too, and the report shows `skipped: 1` for both.
- `sleep: "5m"` inside a `while` with `max_loops: 3` and `run_timeout: "10m"` fails validation with `sleep_exceeds_timeout`. Under `pipeline.test`, a `sleep: "1m"` completes in under a second of wall time and moves the fake clock by one minute.
- `log` with an unresolvable placeholder never fails. 150 messages through one `log` give 100 entries and one `logs_truncated` warning.
- A v0 example pipeline yields the same `permissions_hash` and the same `host.llm` keys before and after these components are added.

## Open points

- **Order after a `switch` whose cases change ids** is group order, which agents may not expect. Restoring order would mean tracking lineage through every component. Revisit if real pipelines show agents relying on order.
- **`sort_by` and `take`** ("the ten newest"), `group_by_value`, `json_schema`, `cached` and `text_chunker` are tier 2 in the grilling record and are not in this spec.
- **No parsing step turns model text into JSON yet**, so `split` over a model's list needs one before it can be used for that purpose. It is a natural companion to `json_schema`; it is not in grilling decisions 1–12.
- **Whether `components.list` should render conditions as English** for the agent's own explanation to the person. Conditions carry no permission, so approval does not need it.
