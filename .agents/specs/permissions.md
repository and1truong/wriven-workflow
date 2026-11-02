# Permissions: derived, pinned, rendered in English

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 7, 11), [ADR 005](../decisions/005-permissions-derived-and-pinned.md), [ADR 004](../decisions/004-isolation-process-seatbelt-proxy.md). Wriven sidecar decision 13: "Lời duyệt do code sinh từ config, model không viết." Stage: **Design — spec**.

## Scope

What a stream's permissions are, how the engine computes them from a pipeline, how they are rendered into English sentences the host shows for approval, how they are pinned and compared on update, and how they become the sandbox profile and proxy allowlist at run time.

## Observable behaviour

- The agent never writes a permission. `pipeline.validate` and `stream.create` return the permissions the engine computed. There is no field in the pipeline format for them.
- The same pipeline always yields the same permissions object and the same sentences, byte for byte. The `permissions_hash` is a SHA-256 of the canonical JSON of the object.
- Approval pins the hash. A later `stream.update` whose permissions are a subset of the pinned ones applies at once; anything else returns the stream to `pending_approval` with the new sentences and a `diff` listing added and removed sentences.
- At run time the derived permissions are the only source for the Seatbelt profile and the proxy allowlist. A component cannot ask for more at run time; a request outside the allowlist is denied by the proxy and reported as the typed error `permission_denied` with the attempted host.
- The rendering always ends with what the stream **cannot** do and with the sandbox status, so an approval screen is never silent about the mechanism's limits.

## The permissions object

```json
{
  "version": 1,
  "runs": { "kind": "host" | "schedule", "cron": "0 8 * * 1-5", "timezone": "Australia/Brisbane", "missed": "run_once" },
  "network": [ { "host": "example.com", "scheme": "https", "methods": ["GET"] } ],
  "network_retry": { "max_attempts": 3 } | null,
  "llm": { "max_calls_per_run": 1, "max_cost_per_run_usd": 0.10 | null, "receives_fetched_content": true } | null,
  "results": { "kind": "host" | "none", "retry": { "max_attempts": 3 } | null },
  "state": { "kind": "dedupe", "remember": "90d", "max_keys": 10000 } | null,
  "skips_failed_sources": true,
  "limits": { "runs_per_day": 2, "run_timeout": "5m" },
  "denied": ["subprocess", "filesystem_outside_state", "network_outside_list", "inbound_network", "provider_keys"]
}
```

Rules of derivation, per component:

| Component | Contributes |
| --- | --- |
| `host_trigger` | `runs.kind = "host"` |
| `schedule` | `runs.kind = "schedule"`, `cron`, `timezone`, `missed` |
| `http_fetch` | one `network` entry per distinct host (lowercased, no port other than 443), `methods: ["GET"]`; `network_retry` if `retry` is set; `skips_failed_sources` if `on_error: skip` |
| `parse_feed` | `skips_failed_sources` if `on_error: skip` |
| `dedupe` | `state` with its `remember` and `max_keys` |
| `collect`, `template` | nothing |
| `host_llm` | `llm.max_calls_per_run = limits.llm_calls_per_run`; `max_cost_per_run_usd = limits.llm_cost_per_run_usd`; `receives_fetched_content = true` when any `http_fetch` precedes it |
| `host_result` | `results.kind = "host"`, `retry` if set |
| `drop` | `results.kind = "none"` |
| `limits` | `limits.runs_per_day`, `limits.run_timeout` |
| always | the `denied` list, which is constant in v0 and exists so the rendering can state it |

`network` entries are sorted by host; arrays are deduplicated; the object is serialized with sorted keys and no whitespace before hashing. That is the canonical form.

## Rendering

The engine renders the object into an ordered list of English sentences. The host shows them as they are, or re-renders from the object if it wants different words; both are allowed because the object is the contract and the sentences are derived from it by the same code every time. Sentence templates (v1):

| Field | Sentence |
| --- | --- |
| `runs.kind = host` | "Runs: when Wriven asks." The host passes its own display name at `initialize` (`host.display_name`); the default is "the host". |
| `runs.kind = schedule` | "Runs: every weekday at 08:00 (Australia/Brisbane)." The cron renderer covers the common forms (every N minutes, hourly, daily at HH:MM, weekdays, specific weekdays, monthly on day D); anything else renders as "Runs on the schedule `0 8 * * 1-5` (Australia/Brisbane)." |
| `runs.missed` | "If a run is missed while the host is closed, it runs once when the host next asks." / "…missed runs are skipped." / "…every missed run is made up." (The schedule words adapt to who owns the clock.) |
| `network` | "Fetches from: example.com, blog.example.org, news.example.net (GET only, over HTTPS)." Empty list: "Fetches from: nowhere." |
| `network_retry` | "Retries a failed fetch up to 3 times." |
| `skips_failed_sources` | "Skips a source that cannot be fetched or read that day, and says so in the run report." |
| `llm` | "Uses: the AI provider of this chat, at most 1 request per run." The host may replace "the AI provider of this chat" with the provider's name; the engine does not know it. |
| `llm.max_cost_per_run_usd` | "Stops a run that would cost more than $0.10, when the provider reports cost." If the host said at `initialize` that it cannot report cost: "Cost limit: not enforceable with this provider." |
| `llm.receives_fetched_content` | "Sends fetched web content to the AI provider." |
| `results.kind = host` | "Writes results to: Wriven." (host display name) |
| `results.retry` | "Retries writing a result up to 3 times." |
| `state` | "Keeps: a list of items already seen, on this Mac, for 90 days (up to 10,000 items)." |
| `limits` | "Limits: at most 2 runs per day; each run stops after 5 minutes." |
| `denied` | "Does not: run programs, read or write your files, listen for connections, send data anywhere not listed above, or hold any API key." |
| sandbox status | "OS sandbox: on (macOS Seatbelt)." or "OS sandbox: unavailable on this Mac; only the engine's own checks apply." The status is a property of the engine at `initialize`, not of the pipeline, and is appended to every rendering. |

Numbers are formatted with thousands separators; durations in words ("5 minutes", "90 days"); times in 24-hour form with the IANA zone in parentheses.

## Worked example

For the pipeline in [pipeline-format](pipeline-format.md#document-shape), with `clock: host` and `host.display_name = "Wriven"`:

```
Runs: when Wriven asks.
Fetches from: blog.example.org, example.com, news.example.net (GET only, over HTTPS).
Skips a source that cannot be fetched or read that day, and says so in the run report.
Keeps: a list of items already seen, on this Mac, for 90 days (up to 10,000 items).
Uses: the AI provider of this chat, at most 1 request per run.
Sends fetched web content to the AI provider.
Writes results to: Wriven.
Limits: at most 2 runs per day; each run stops after 5 minutes.
Does not: run programs, read or write your files, listen for connections, send data anywhere not listed above, or hold any API key.
OS sandbox: on (macOS Seatbelt).
```

## Pinning and comparison

- `stream.create` stores `permissions`, `permissions_hash`, `rendered` (the sentences) and `rendered_version` in the manifest with status `pending_approval`.
- `stream.approve { stream_id, permissions_hash }` succeeds only if the hash equals the manifest's; otherwise `conflict` with the current hash, so a host that showed stale sentences cannot approve by accident.
- "Subset" for `stream.update`, per field: `network` new ⊆ old; `llm.max_calls_per_run` new ≤ old and `receives_fetched_content` not newly true; `max_cost` new ≤ old (null counts as unbounded, so introducing a cost cap is a subset, removing one is not); `runs_per_day` new ≤ old; `run_timeout` new ≤ old; `state.remember` and `max_keys` new ≤ old; `network_retry` and `results.retry` attempts new ≤ old (null = 0); `skips_failed_sources` may go true→false, not false→true; `runs` must be identical (any schedule change re-approves: it is cheap and the person should see it); `results.kind` must be identical.
- Anything not a subset: manifest gets `pending.permissions*` and status `pending_approval`; the active pipeline is retained as `manifest.previous.json` and is no longer runnable until approved or rolled back. `stream.update` returns `{ "status": "pending_approval", "diff": { "added": [sentences], "removed": [sentences] } }`.

## From permissions to enforcement

At run start the supervisor derives two artifacts from the pinned object:

**Seatbelt profile** (generated text passed to `sandbox-exec -p`): `(version 1) (deny default)`; allow `file-read*` for the engine binary, its dynamic libraries, the system paths a Bun binary needs to start (to be enumerated by ticket 04 by observing denials in `doctor`), `/dev/null`, `/dev/urandom`, and `<state_dir>/streams/<id>/`; allow `file-write*` only for `<state_dir>/streams/<id>/` and the run's private temp directory; deny `process-exec` and `process-fork` except the initial exec of the binary itself; allow `network-outbound` only to `(remote tcp "localhost:<proxy_port>")`; deny `network-inbound`, `network-bind`; allow the Mach lookups a Bun process needs to start and nothing else (enumerated the same way; the Codex CLI's experience with `configd` crashes shows this list needs measuring, not guessing).

**Proxy allowlist**: the `network` entries. The proxy accepts `CONNECT host:443` only for listed hosts, refuses everything else with HTTP 403 and reports `permission_denied` to the run; it does not inspect TLS payloads. Plain `http://` is refused (validation already forbids it). Redirect targets are re-checked because the run process issues a new `CONNECT` for each.

If `sandbox-exec` is missing or the profile fails to compile, the run does not start (`sandbox_unavailable`) unless the host set `sandbox: "optional"` at `initialize`, in which case the run starts without OS sandbox and the report's `sandbox` field says `none`; the rendering already warned the person.

## Decisions and reasons

1. **Derived, not declared.** A declaration written by the agent can be wrong or dishonest; a derivation cannot disagree with the pipeline. It also removes a whole class of validation ("declared ⊇ needed").
2. **Sentences from code, object as contract.** The host may want its own wording or language; the object lets it, and the engine's sentences give it a correct default. Wriven's rule that the model never writes approval text is satisfied by construction.
3. **Any schedule change re-approves.** Cheap for the person, and "runs more often" is exactly the kind of widening that should not slip through a subset rule on numbers alone.
4. **State the denials.** The person approving should see that "no programs, no files" is part of the deal, not assume it.
5. **Sandbox status is always rendered.** Hong's requirement from the Q11 revision: never silent when the OS sandbox is absent.
6. **No `allow` field for the host.** The host cannot grant a stream more than its pipeline implies, only less (lower ceilings at `initialize`). That keeps the engine's permission story independent of host UI mistakes.

## Risks

- A sentence set that is correct but long. Ten lines for the example is acceptable; a pipeline with twenty hosts renders twenty hosts. The host may collapse the list; the object is unchanged.
- Hash stability across engine versions: adding a field to the permissions object changes the hash of every existing stream. Rule: a new field with its zero value is excluded from canonical form, so existing hashes survive; `version` only bumps when that is impossible, and then every stream re-approves at upgrade, with a rendering that says why.
- Seatbelt profile minimalism versus Bun's startup needs. The list of required reads and Mach services must be measured per Bun version (ticket 04) and pinned in the repository with the version it was measured against.

## Acceptance criteria

- The worked example renders exactly the ten lines above given `clock: host`, `display_name: "Wriven"`, sandbox available.
- Reordering `urls`, reordering keys in the JSON, or adding whitespace does not change `permissions_hash`.
- Adding a URL on a new host via `stream.update` returns `pending_approval` with `diff.added` containing the new "Fetches from" sentence and `diff.removed` containing the old one; removing a URL applies immediately.
- Changing `cron` from `0 8 * * 1-5` to `0 7 * * 1-5` returns `pending_approval`.
- `stream.approve` with a stale hash returns `conflict`.
- Under the generated Seatbelt profile, a run process that attempts to read `~/.ssh/id_rsa`, write `/tmp/x`, `fork`/`exec` `/bin/sh`, or connect to `1.1.1.1:443` fails each attempt; connecting to the proxy port succeeds. Verified in `doctor --self-test`.
- The proxy refuses `CONNECT evil.example:443` with 403 when `evil.example` is not in the list, and the run report shows `permission_denied` with that host.
- With `sandbox-exec` absent (simulated by `PATH` manipulation in the test), `initialize` reports sandbox unavailable, the rendering's last line changes accordingly, and a run is refused unless `sandbox: "optional"`.

## Open points

- Whether the host should be able to pass a per-pipeline network ceiling at approval time (for example "only these hosts, ever"). Not in v0; the per-engine ceilings at `initialize` cover the near-term need.
