# Protocol conformance fixtures

One JSON file per scenario: the lines a host sends and what it must see. `wriven-workflow fake-host --conformance <dir>` replays them against an engine and prints pass or fail per scenario, with `--engine <path>` to test a particular binary and `--verbose` to print every line both ways. A host author can read them as examples of the protocol.

| File | Scenario |
| --- | --- |
| `01-initialize-shutdown` | Handshake, explicit shutdown, exit 0 |
| `02-validate` | The example pipeline with its ten sentences, then three invalid variants |
| `03-run-success` | Create → approve → trigger → `host.llm` → `host.result` → `run.finished` |
| `04-quota-exhausted` | A typed provider error fails the run; no result; no retry |
| `05-lost-llm-response` | A dropped response: same key, `attempt: 2`, one provider call |
| `06-update-narrow-widen` | A narrowing update applies; a widening one needs approval with a diff |
| `07-cancel-during-llm` | `run.cancel` sends `$/cancel` and reports `cancelled` |
| `08-stdin-eof-during-run` | The host goes away: `run.finished` cancelled, exit 0 |
| `09-two-engines` | A second engine on one `state_dir` fails `conflict` |
| `10-sandbox-unavailable` | `sandbox: required` with no `sandbox-exec`: refused at trigger |
| `11-concurrent-llm` | A host declaring `llm_concurrency: 2` sees two `host.llm` requests from two `workflow` branches before answering either; cancel sends `$/cancel` for both |

## Format

```json
{
  "name": "…",
  "description": "…",
  "env": { "PATH": "/nonexistent" },
  "fake_host": { "llm": { "responses": ["Hello."], "drop_responses": 1 }, "result": { "fail_first": 1 } },
  "steps": [ … ]
}
```

`env` is added to the engine's environment. `fake_host.llm` scripts how the fake host answers `host.llm`: `responses` in order (the last repeats), `mode: "echo"`, `mode: "hold"` (never answers until `$/cancel`), or `error: { kind, message, … }`. It keeps a record by `idempotency_key` as a real host must, and that record is what `assert_fake_host` counts.

Each step does one thing:

| Step | Meaning |
| --- | --- |
| `{ "send": <message> }` | Write this line to the engine's stdin |
| `{ "expect": <pattern>, "capture": { "name": "/json/pointer" }, "within_ms": 20000 }` | Wait for a line matching the pattern, not already matched by an earlier step. Other lines in between are fine, because responses may arrive out of order. `capture` stores a value for later steps |
| `{ "expect_absent": <pattern> }` | No line so far matches |
| `{ "close_stdin": true }` | Close the engine's stdin |
| `{ "expect_exit": 0, "within_ms": 11000 }` | The engine exits with this code in time |
| `{ "assert_fake_host": { "provider_calls": 1, "results": 1 } }` | What the fake host's record holds |
| `{ "start_engine": "second" }`, and `"engine": "second"` on later steps | A second engine |
| `{ "sleep_ms": 100 }` | Wait |

## Placeholders

In a pattern, objects match by subset: fields not mentioned may be anything. Arrays match element by element and in length, unless the last element is `"<...>"`.

| Placeholder | Matches |
| --- | --- |
| `"<any>"` | Any value that is present |
| `"<string>"` | A string |
| `"<number>"` | A number |
| `"<time>"` | A string that parses as a time |
| `"$name"` | The value captured as `name`; inside a longer string it is substituted. `$state_dir` is a fresh `0700` directory for the scenario |
