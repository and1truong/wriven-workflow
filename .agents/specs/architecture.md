# Architecture: core, processes, stream lifecycle

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 1, 3, 4, 8, 11, 13), [ADR 001](../decisions/001-runtime-bun.md), [ADR 002](../decisions/002-host-owns-keys-clock-history.md), [ADR 004](../decisions/004-isolation-process-seatbelt-proxy.md). Stage: **Design — spec**. Implementation under `src/`.

## Scope

How the engine is laid out as processes and modules, what a stream and a run are, how they move between states, and what each process may touch. The wire format with the host is in [host-protocol](host-protocol.md); the pipeline document in [pipeline-format](pipeline-format.md); acknowledgement rules in [delivery-semantics](delivery-semantics.md); sandbox contents in [permissions](permissions.md) and [threat-model](threat-model.md).

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Host** | The parent process. Owns provider keys, the user interface, approval, run history and results. First host: Wriven Desktop. |
| **Engine** | The `wriven-workflow serve` process the host spawns. One per host. Speaks JSON-RPC 2.0 over its stdin/stdout. Owns stream manifests, operational state, the sandbox and the egress proxy. |
| **Pipeline** | A JSON document: one input, an ordered list of processors, one output, mandatory limits, optional schedule. Written by the agent. |
| **Stream** | A pipeline installed in the engine under a `stream_id`, with a status and pinned permissions. |
| **Run** | One execution of a stream, triggered by the host, by the engine's own schedule, or by a test. Identified by `run_id`. |
| **Run process** | The sandboxed child process the engine spawns for one run. Executes exactly one pipeline once, then exits. |
| **Message** | `{ id, data, meta }` where `data` is JSON and `meta` is a flat string map. Messages travel in **batches**; a batch carries one acknowledgement. |
| **Component** | An input, processor or output type with a JSON Schema for its config and a declaration of what permissions its config implies. Components are compiled into the binary. |
| **Permissions** | The derived, structured description of what a stream may do, plus its English rendering. Computed by the engine from the pipeline, never written by the agent. |

## Observable behaviour

- The host starts the engine, sends `initialize`, and from then on the engine does nothing until asked: no run starts, no network connection opens, no file is written outside the state directory the host named.
- When the host's stdin to the engine closes, the engine stops accepting work, lets in-flight runs drain for the shutdown timeout (default 10 seconds), kills what remains, and exits. No engine process outlives its host.
- A run never happens inside the engine process. Every run is a child process that the engine wraps in an OS sandbox. If the sandbox cannot be set up, the run does not start and the error says so; the engine does not fall back to running unsandboxed.
- One run at a time per engine. Triggers that arrive while a run is in progress queue in order; a queued trigger for the same stream collapses into one.
- A run that exceeds its `run_timeout` is killed and reported as `timed_out`. A run process that exceeds the memory ceiling is killed and reported as `failed` with reason `memory_limit`. The engine survives both.
- Operational state (dedupe cursors, schedule bookmarks) lives in `<state_dir>/streams/<stream_id>/`. Run results and run history never live there; they go to the host.

## Process model

```
host (Wriven)
 │  stdio: JSON-RPC 2.0, newline-delimited
 ▼
engine  wriven-workflow serve
 ├── control: handshake, stream registry, manifests, approvals
 ├── scheduler (active only when clock=engine)
 ├── run queue (depth 1 executing, FIFO waiting)
 ├── egress proxy  127.0.0.1:<ephemeral>  HTTP CONNECT + plain HTTP, allowlist per run
 ├── state store   <state_dir>/streams/<id>/{manifest.json, state.json, state.json.tmp}
 └── supervisor: spawns, sandboxes, watches and kills run processes
       │  stdio: internal run protocol (not public, versioned with the binary)
       ▼
     run process  sandbox-exec -p <profile> wriven-workflow --run
       └── pipeline executor: input → processors → output, one ack per batch
```

- **Engine ↔ host** is the only public interface. Its versioning, methods and errors are in [host-protocol](host-protocol.md).
- **Engine ↔ run process** is private: the same binary on both ends, so the format is whatever the binary's version needs. It carries the pipeline, the derived permissions, the proxy port, injected input and mocks for tests, and, in the other direction, `host.llm` requests to forward, `host.result` payloads to forward, progress, and the final run report.
- **Run process ↔ world**: only two paths. Outbound HTTP through the engine's proxy, filtered by host allowlist, and state files under its own stream directory. Everything else is denied by the Seatbelt profile. A `host_llm` step is a message to the engine over stdio, which the engine forwards to the host; the run process has no provider key and no network route to a provider.

## Modules inside the binary

One binary, several entry points selected by the first argument. Agent mode never loads code from disk.

| Entry | Purpose | Loads pipelines from |
| --- | --- | --- |
| `serve` | Engine for a host; JSON-RPC over stdio | the host, over RPC |
| `--run` | Run process; private protocol over stdio | the engine, over stdio |
| `validate <file>` | Human/CI use; prints validation result and permissions as JSON | a file (JSON or YAML) |
| `test <file>` | Human/CI use; runs the pipeline's embedded tests with fake host | a file |
| `fake-host` | Development harness: a host that speaks the public protocol, approves on request, answers `host.llm` from fixtures or an echo, prints `host.result` | its arguments |
| `doctor` | Prints runtime versions, sandbox availability, proxy self-test | none |
| `--version` | Prints engine version, supported protocol versions, supported pipeline format versions, report version | none |

Internal module boundaries (one directory each; names indicative):

- `protocol/`: JSON-RPC framing, method tables, typed errors, version negotiation. No business logic.
- `pipeline/`: document model, JSON Schema for the format, validation, permission derivation, English rendering.
- `components/`: the eleven v0 components, each with `schema`, `permissions(config)`, and `create(config, ctx)`.
- `executor/`: batches, acks, backpressure, cancellation, run report. Runs only inside a run process.
- `supervisor/`: spawn, Seatbelt profile generation, proxy, watchdog, kill.
- `scheduler/`: cron parsing, time zone arithmetic, missed-run policy. Pure functions plus one timer loop.
- `state/`: manifests and per-stream state, atomic writes.
- `harness/`: fake host, fake clock, fixtures. Shipped in the binary because `pipeline.test` uses it.

## Stream lifecycle

```
            stream.create ──► pending_approval ──stream.approve──► active
                                   │   ▲                            │  ▲
                                   │   │ stream.update (widens)     │  │ stream.resume
                                   │   └────────────────────────────┤  │
                                   │                                ▼  │
                                   │                              paused
                                   │                                │
                        stream.delete (any state) ──────────────────┴──► deleted
```

- `pending_approval`: manifest stored with `permissions_hash`; no run may start; `run.trigger` is refused with `permission_denied`.
- `active`: runs may be triggered (by host, or by the engine's scheduler when it owns the clock).
- `paused`: manifest kept, runs refused with `conflict` (reason `paused`). Scheduled occurrences that pass while paused are not caught up on resume (decision 12 of the Wriven scheduled-actions grilling; see [scheduling](scheduling.md)).
- `stream.update` with a pipeline whose derived permissions are a subset of the pinned ones applies immediately and keeps the state; any other change moves the stream to `pending_approval` with the new hash, and the old pipeline stops being runnable. The previous manifest is kept as `manifest.previous.json` so the host can offer rollback through `stream.update` with the previous pipeline, which is always a subset and therefore needs no new approval.
- `deleted`: manifest and state removed. The host keeps the run history; the engine has none to remove.

A stream's status is also the answer to "is this running when I'm not looking": only `active` streams ever run.

## Run lifecycle

```
trigger ─► queued ─► running ─► succeeded
                        │   ├──► failed        (typed error, step id)
                        │   ├──► timed_out     (run_timeout)
                        │   └──► cancelled     (run.cancel, shutdown, host gone)
                        └──────► skipped       (limit reached before start: runs_per_day, paused)
```

- Each run gets a UUIDv7 `run_id` from the engine, plus `trigger` (`host`, `schedule`, `test`), `scheduled_for` (the occurrence it stands for, if any) and `started_at`. The report distinguishes them so the host can show "ran at 08:03 for the 08:00 schedule".
- The engine emits `run.started` and `run.finished` notifications to the host; the latter carries the full run report (see [host-protocol](host-protocol.md#run-report)).
- The run process is spawned fresh per run and exits when the report is sent. There is no warm pool in v0.
- Cancellation: `run.cancel` aborts in-flight HTTP in the run process, sends `$/cancel` to the host for any outstanding `host.llm`, and lets the run process finish its report within 5 seconds, after which it is killed. See [delivery-semantics](delivery-semantics.md#cancellation-and-shutdown).

## Decisions and reasons

1. **Run-scoped processes, not long-lived workers.** Bun ignores worker `resourceLimits` and has no permission model (measured 2026-11-03, [research](../research/research-runtime.md)), so isolation must come from the OS. A process per run is the simplest unit the OS can sandbox and kill, matches how Wriven already treats Codex (one short process per turn), and makes "a run is a unit of delivery" literal. Cost: process spawn per run (tens of milliseconds for a 60 MB Bun binary, measured 7 ms startup for a hello world) and no shared caches between runs. Long-lived inputs such as an HTTP server would need a different unit; they are out of v0.
2. **One engine per host, one run at a time.** Sequential runs match the Wriven scheduled-actions decision ("chạy lần lượt từng cái") and make the cost ceiling and the proxy allowlist trivially per-run. Parallel runs are a knob for later; the queue is already there.
3. **The engine owns no provider calls and no history.** Every `host_llm` call and every result crosses the host boundary. The engine's state directory therefore contains nothing the person would want to read, which keeps the "hide the mechanism" promise honest. See [ADR 002](../decisions/002-host-owns-keys-clock-history.md).
4. **Private protocol between engine and run process.** Both ends are the same binary, so no compatibility promise is needed there and the format can change freely. The public contract stays small.
5. **Harness ships in the binary.** `pipeline.test` must run offline with mocked `host_llm` (Wriven sidecar decision 15), so the fake host and fixtures are product code, not dev tooling.
6. **Components compiled in.** Agent mode has no module loading path, by construction rather than by configuration (Wriven sidecar decision 14).

## Risks

- `sandbox-exec` is marked deprecated by Apple and its profile language is undocumented. Codex CLI and Anthropic's `sandbox-runtime` depend on it today; if Apple removes it, the engine loses OS isolation and must say so. The permissions rendering always includes the sandbox status so this never fails silently. Mitigation path: an App Sandbox helper once Wriven ships as a `.app`. See [ADR 004](../decisions/004-isolation-process-seatbelt-proxy.md).
- Spawning a process per run under a sandbox on a laptop that may be asleep or under load: startup latency is not the issue, but Seatbelt profile compilation errors are. `doctor` and the first-run self-test must surface them early.
- A single engine instance assumes a single host instance. Wriven has no single-instance lock (read in its code, 2026-11-03). Two hosts starting two engines on the same `state_dir` would race on state files. The engine takes an advisory lock on `<state_dir>/engine.lock` and refuses `initialize` with `conflict` if it is held.

## Acceptance criteria

- Starting `wriven-workflow serve` and closing its stdin exits the process within the shutdown timeout with no child processes left, verified with a fake host test that counts descendants.
- With the fake host, a pipeline run executes in a child process whose PID differs from the engine's and whose parent is the engine; the child exits before `run.finished` arrives.
- `run.trigger` on a `pending_approval` stream returns `permission_denied`; on a `paused` stream returns `conflict`.
- Two `run.trigger` calls for the same active stream while a run is in progress produce exactly one additional run.
- Killing the run process externally yields a `run.finished` report with status `failed` and reason `process_exited`, and the engine keeps serving.
- Starting a second engine on the same `state_dir` fails `initialize` with `conflict`.
- `wriven-workflow --version` prints engine, protocol, pipeline-format and report versions as JSON.

## Open points

- Whether to allow one concurrent run per stream in addition to the global queue (the host may want "Run now" to work while a scheduled run of another stream is in progress). Default in this spec: global depth 1.
- The memory ceiling for a run process: 512 MB RSS is the placeholder. Measure with the feed example before fixing it.
