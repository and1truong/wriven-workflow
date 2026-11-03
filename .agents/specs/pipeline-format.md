# Pipeline format

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 4, 5, 7, 9), [ADR 003](../decisions/003-no-expression-language.md), [ADR 007](../decisions/007-json-canonical-format.md), [ADR 008](../decisions/008-mandatory-limits.md). Stage: **Design — spec**.

## Scope

The document an agent writes: its shape, the eleven v0 components and their configuration, the field-reference syntax, versioning, and what `pipeline.validate` checks. Permission derivation from this document is in [permissions](permissions.md). How messages flow through it is in [delivery-semantics](delivery-semantics.md).

## Observable behaviour

- A pipeline is a JSON object. The CLI also accepts YAML and converts it to JSON before anything else looks at it; the engine's RPC methods accept JSON only.
- Every pipeline names its format version. The engine publishes a JSON Schema per format version, obtainable with `components.list` (the schema includes the component schemas) and in the release artifacts.
- Validation is total: a valid pipeline either runs or fails for a reason outside the document (network, host, limits). "Valid" includes the field references resolving to something a component can read.
- There is no expression language. A field is referenced by a JSON Pointer (RFC 6901) into the message's `data`, or by `meta:<key>` into its metadata. Text is built by `template` with `{{/pointer}}` placeholders and nothing else.

## Document shape

```json
{
  "format": "wriven-workflow/pipeline@1",
  "name": "Morning feed digest",
  "description": "Summarize new posts from three feeds every weekday morning.",
  "input": { "type": "host_trigger" },
  "processors": [
    { "id": "fetch", "type": "http_fetch",
      "urls": ["https://example.com/feed.xml", "https://blog.example.org/rss", "https://news.example.net/atom.xml"],
      "on_error": "skip" },
    { "id": "parse", "type": "parse_feed", "on_error": "skip" },
    { "id": "new_only", "type": "dedupe", "key": "/id", "remember": "90d" },
    { "id": "gather", "type": "collect", "min_items": 1, "max_items": 50 },
    { "id": "prompt", "type": "template",
      "target": "/prompt",
      "text": "Summarize these posts for a busy reader. Group by theme, keep links.\n\n{{/items}}" },
    { "id": "summarize", "type": "host_llm", "prompt": "/prompt", "target": "/summary" }
  ],
  "output": { "type": "host_result", "title": "Morning digest", "body": "/summary", "format": "markdown" },
  "limits": { "llm_calls_per_run": 1, "runs_per_day": 2, "run_timeout": "5m" }
}
```

Top-level fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | `wriven-workflow/pipeline@<major>`. v0 publishes `@1`. |
| `name` | yes | Shown to the person by the host. 1–80 characters. |
| `description` | no | Shown to the person. ≤ 500 characters. |
| `input` | yes | Exactly one input component. |
| `processors` | yes, may be empty | Ordered list. Each has an `id` (`^[a-z][a-z0-9_]{0,31}$`) used in run reports, errors and idempotency keys, unique across the whole pipeline, steps nested in containers included. |
| `output` | yes | Exactly one output component. |
| `limits` | yes | See [Limits](#limits). Missing or out of range is a validation error. |
| `schedule` | no | Only meaningful when the input is `schedule`; see [scheduling](scheduling.md). Kept at top level so the host can read it without knowing components. |
| `tests` | no | Embedded tests; see [agent-surface](agent-surface.md#pipeline-tests). |

Unknown top-level fields and unknown component fields are errors, not warnings. An agent that invents a field learns immediately.

## Message model

A message is `{ "id": string, "data": JSON, "meta": { string: string } }`. `id` is assigned by the component that creates the message and is stable for the run; `dedupe` and the `host_llm` idempotency key use it. Components document which `data` shape they produce.

Field references:

- `/a/b/0` — JSON Pointer into `data`. Must resolve at validation time against the upstream component's declared output shape when that shape is known; otherwise it is checked at run time and a miss is a processor error.
- `meta:source_url` — a metadata key.
- In `template.text`, `{{/pointer}}` and `{{meta:key}}` are the only placeholders. A pointer that resolves to a non-string is rendered as compact JSON. There are no filters, conditionals or loops. An array pointer renders as a JSON array; `collect` exists so that "all items as one text" is a component decision, not a template feature.

## Components (v0)

Each component states: config fields, what it reads and emits, how it behaves on error, and the permission it implies (the full rendering is in [permissions](permissions.md)). Durations use the form `<integer><unit>` with units `s`, `m`, `h`, `d`.

### Inputs

**`host_trigger`** — emits one message per run: `data = { "trigger": "host" | "schedule", "scheduled_for": <RFC 3339 or null>, "run_id": string }`. No config. Permission: "Runs: when the host asks." or, when the host owns the clock and passes a schedule in `run.trigger`, the schedule sentence the host provides.

**`schedule`** — same message as `host_trigger`, fired by the engine's scheduler. Config: `cron` (5-field), `timezone` (IANA), `missed` (`skip` | `run_once` | `run_all`, default `run_once`). Valid only when the handshake said `clock: engine`; otherwise validation returns `invalid_pipeline` with reason `schedule_requires_engine_clock` and the agent should use `host_trigger`. Permission: "Runs: <human rendering of cron> (<timezone>)."

**`inject`** — test-only input. Config: `messages: [{ data, meta? }]`. Emits them as one batch. Valid only inside `pipeline.test` or a `tests[]` entry; a stream whose input is `inject` fails `stream.create` with `invalid_pipeline`.

### Processors

**`http_fetch`** — for each incoming message, performs one GET per URL in `urls` (1–20 entries, `https` only, no credentials in URL, no IP literals, no `localhost`/`.local`/private ranges) and emits one message per URL: `data = { "url", "status", "headers": {lowercased}, "body": string, "content_type" }`, `meta.source_url`. Config: `urls`, `headers` (allowlisted request headers: `accept`, `accept-language`, `user-agent`; nothing else), `timeout` (default `30s`, max `120s`), `max_bytes` (default 2 MB, max 5 MB), `on_error` (`fail` default | `skip`), `retry` (optional `{ "max_attempts": 2–3, "backoff": "1s" }`; absent means no retry). Non-2xx is an error. Follows at most 3 redirects, each re-checked against the allowlist. Permission: "Fetches from: host1, host2 (GET only)." plus "Retries fetches up to N times." when `retry` is set.

**`parse_feed`** — reads `/body` (RSS 2.0, Atom 1.0, RSS 1.0), emits one message per entry in the same batch: `data = { "id", "title", "link", "published": RFC 3339 or null, "summary": plain text, "content": plain text, "author", "feed": { "title", "url" } }`. `id` is the entry's `guid`/`id`, else `link`, else a hash of title and published. HTML in summaries is stripped to text; the raw HTML is not kept. Config: `max_entries` (default 100, max 500), `on_error` (`fail` | `skip`). A body that is not a feed is an error. Permission: none beyond the fetch.

**`dedupe`** — drops messages whose `key` value has been seen in a previous **successful** run of this stream. Config: `key` (pointer), `remember` (default `30d`, max `365d`), `max_keys` (default 10 000). Seen keys are committed to state only when the run succeeds (see [delivery-semantics](delivery-semantics.md#state-and-acknowledgements)). An empty batch after dedupe is dropped and counts as success. Permission: "Keeps: a list of items already seen (on this Mac, for 90 days)."

**`collect`** — turns the current batch into one message: `data = { "items": [data of each message in order], "count": n }`, `meta` from the first message. Config: `min_items` (default 1; a batch below it is dropped as success), `max_items` (default 100, max 1000; extra items are dropped and reported as a warning, not an error). Permission: none.

**`template`** — writes the rendered `text` to `target` (a pointer into `data`; parent must exist or be the root). Config: `text` (≤ 20 000 characters), `target`. Placeholders as above. A placeholder that does not resolve is a processor error (strict), unless `missing: "empty"` is set. Permission: none.

**`host_llm`** — sends `prompt` (pointer to a string) to the host and writes the reply text to `target`. Config: `prompt`, `target`, `system` (optional literal string, ≤ 4 000 characters, no placeholders), `max_output_tokens` (optional, ≤ 8 192). The engine counts calls against `limits.llm_calls_per_run` **before** forwarding; the host counts again. One call per message; to make one call for many items, put `collect` before it. Errors from the host are typed and end the run (no retry, ever). Permission: "Uses: the AI provider, at most N requests per run." and, when any upstream component fetched from the network, "Sends fetched web content to the AI provider."

### Composition components (after v0)

Specified in [composition](composition.md), which owns their behaviour; this list records which ones the engine has.

Containers hold step lists; a nested step has the same shape as a top-level processor. At most 4 containers nest and a pipeline has at most 64 steps in all; both are compiled in and reported by `components.list` as `structure`. In the published schema, nested lists and conditions are `$ref`s into `#/$defs/processor` and `#/$defs/condition`.

- **`for_each`**: runs `steps` on each message as a batch of one, outputs in input order. Permission: none of its own.
- **`try`**: runs `steps`; a unit that fails at one of them leaves them, and goes through `catch` (with `meta.error_step`, `error_code`, `error_message`), is dropped (`catch: []`) or fails the run (no `catch`). Permission: `skips_failed_items` with `catch: []`, `handles_failed_items` with `catch` steps.
- **`while`**: repeats `steps` per message while `repeat_while` holds, at most `max_loops` (required, 1–20); the body must keep message ids (`changes_message_ids`). Permission: none of its own.
- **`switch`**: routes each message to the first case whose `when` holds; unmatched go to `default` or pass through. Permission: none of its own.
- **`filter`**: keeps the messages for which `keep_if`, a [`condition`](composition.md#condition), is true. Permission: none.
- **`split`**: one message per element of the array at `field`. Permission: none.
- **`log`**: appends a line per message to the run report's `logs`. Permission: none.
- **`sleep`**: waits once per batch, 1s to 5m; validation code `sleep_exceeds_timeout` when sleeps along one path reach `run_timeout`. Permission: none.

### Outputs

**`host_result`** — sends one result per message to the host: `{ "title": rendered, "body": value at pointer, "format": "markdown" | "text" }`. Config: `title` (literal, ≤ 120 characters), `body` (pointer to string), `format` (default `markdown`). The host decides what a result becomes (in Wriven: a new thread). Permission: "Writes results to: the host." (Wriven renders this as "a new chat in Wriven".)

**`drop`** — acknowledges and discards. For tests and for pipelines whose only effect is state (none in v0). Permission: "Writes results to: nowhere."

## Limits

```json
"limits": {
  "llm_calls_per_run": 1,
  "runs_per_day": 2,
  "run_timeout": "5m",
  "llm_cost_per_run_usd": 0.10
}
```

| Field | Required | Range | Enforced by |
| --- | --- | --- | --- |
| `llm_calls_per_run` | yes | 0–50 | engine (before forwarding) and host (at `host.llm`) |
| `runs_per_day` | yes | 1–48 | engine (per stream, rolling 24 hours, counts started runs including failed ones) |
| `run_timeout` | yes | `30s`–`30m` | engine supervisor (kills the run process) |
| `llm_cost_per_run_usd` | no | > 0 | engine, using `usage.cost_usd` returned by the host when present; when the host returns no cost the limit is reported as "not enforceable" in permissions |

Engine-wide ceilings (the upper ends above) are compiled in and reported by `components.list`. A host may lower them at `initialize` but not raise them. A stream approved before a host lowered a ceiling keeps its pipeline, and each run keeps to the lower of the two. See [ADR 008](../decisions/008-mandatory-limits.md).

## Validation

`pipeline.validate` returns either `{ "valid": true, "permissions": {...}, "warnings": [...] }` or `{ "valid": false, "errors": [ { "path": "/processors/2/key", "code": "unknown_field" | "schema" | "unresolved_pointer" | "limit_out_of_range" | "missing_limits" | "input_not_allowed" | "schedule_requires_engine_clock" | "url_not_allowed" | "shape_mismatch" | "capability_missing" | "sleep_exceeds_timeout" | "duplicate_id" | "nesting_too_deep" | "too_many_steps" | "changes_message_ids", "message": "English sentence" } ] }`.

Checks, in order: JSON Schema of the format version; component schemas; component ordering constraints (`parse_feed` needs a `/body` upstream; `host_llm.prompt` must point at a string-producing field; `collect` after `dedupe` is allowed, before is a warning "dedupe after collect sees one key per batch"); URL rules; pointer resolution against declared shapes; limits; components the host's `capabilities` rule out (`capability_missing`); a `host_llm` present with `llm_calls_per_run: 0` is an error. Warnings never block.

Validation never touches the network or the state directory.

## Versioning

- `format` major changes when a valid `@1` document could mean something different or become invalid. Adding an optional field or a component is not a major change; the engine's `components.list` tells the agent what exists.
- The engine supports a list of format majors, reported at `initialize`. A stream created with `@1` keeps running on an engine that also supports `@2`; `stream.update` may move it.
- Component config fields are never repurposed; a retired field becomes an `unknown_field` error with a message pointing at the replacement.

## Decisions and reasons

1. **JSON canonical, YAML as a CLI convenience.** The pipeline arrives as a tool-call argument, which is JSON on every provider ([research](../research/research-tool-calling.md)). Round-tripping YAML would add a parser to the trust boundary for no gain. [ADR 007](../decisions/007-json-canonical-format.md).
2. **JSON Pointer, nothing richer.** A pointer is a lookup, not a program: it cannot loop, branch or call. Everything that needs to compute is a component with a schema, so it has permissions and tests. [ADR 003](../decisions/003-no-expression-language.md).
3. **Strict unknown fields.** Agents learn from errors; a warning would let a misspelled `on_error` silently mean `fail`.
4. **Processor `id` is mandatory.** Run reports, typed errors and idempotency keys need a stable name. Auto-numbering would shift when the agent inserts a step.
5. **`on_error: skip` instead of `try`/`catch`.** Benthos's flag-and-continue plus `catch` is powerful but it is a control-flow language ([research](../research/research-benthos.md), lesson 2). For agent pipelines the only recoverable error in v0 is "one of several fetches failed"; a per-component switch covers it and renders as a sentence ("Skips a feed that cannot be fetched that day").
6. **`https` only, no private addresses.** The run process can only reach the proxy, and the proxy only allows these hosts, so the URL rules are the first line and the proxy the second.
7. **`collect` added to the agreed ten.** The agreed set could not express "one model call for all new items", which is the whole example. `collect` is the smallest batch-to-message component and it has no permissions. Hong's grilling record notes the addition.

## Risks

- Declared output shapes make pointer validation possible but add maintenance per component. v0 has eleven components; keep shapes in the schema file next to each component.
- A 20 KB `template.text` is a lot of prompt. The ceiling exists so that a runaway agent cannot create megabyte prompts; the host's own context limits still apply.
- Feed parsing in the wild is messy (encodings, HTML entities, relative links). `parse_feed` will need a fixture corpus; see ticket 06.

## Acceptance criteria

- The example above validates with no errors and derives exactly the permission sentences listed in [permissions](permissions.md#worked-example).
- Removing `limits` fails with `missing_limits`; `llm_calls_per_run: 51` fails with `limit_out_of_range`.
- A pipeline with `schedule` input validates when the harness handshake says `clock: engine` and fails with `schedule_requires_engine_clock` when it says `clock: host`.
- `http_fetch` with `http://`, an IP literal, `localhost`, or a URL containing `user:pass@` fails with `url_not_allowed`.
- `host_llm.prompt` pointing at `/items` (an array) fails with `shape_mismatch`.
- An unknown field anywhere fails with `unknown_field` and a path.
- The published JSON Schema accepts every fixture in `fixtures/pipelines/valid/` and rejects every fixture in `fixtures/pipelines/invalid/` with the expected code.

## Open points

- Whether `template` should allow a `{{#each}}`-style loop for item lists. Current answer: no; `collect` renders items as JSON and the model reads JSON well. Revisit with evidence from real digests.
- `parse_feed` on JSON Feed 1.1: cheap to add, not in the example. Not in v0.
