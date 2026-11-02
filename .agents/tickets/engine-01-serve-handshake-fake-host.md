# engine-01: `serve` speaks the protocol, exits on stdin EOF, and a fake host drives it

**Spec:** [host-protocol](../specs/host-protocol.md) (transport, handshake, `shutdown`, typed errors), [architecture](../specs/architecture.md) (process model, entry points). [ADR 001](../decisions/001-runtime-bun.md).

**To build:** A Bun project that compiles to one binary with `serve`, `fake-host`, `--version` and `doctor` entry points. `serve` reads NDJSON JSON-RPC 2.0 from stdin, answers `initialize` (protocol version check, `state_dir` checks, `engine.lock`), `components.list` (empty list is fine), `shutdown`, rejects everything before `initialize` with `not_initialized`, and exits 0 within the shutdown timeout when stdin closes. `fake-host` spawns the binary, performs the handshake, and prints every line both ways. `doctor` prints versions and whether `sandbox-exec` exists (no profile yet).

**Blocked by:** none (can start now).

**Verification:** From the spec's acceptance criteria: request before `initialize` → `not_initialized`; `protocol_version: 2` → `unsupported_version` with `supported: [1]`; `state_dir` mode `0755` → `invalid_state_dir`; 4 MiB + 1 byte line → `-32600` and the engine keeps serving; second engine on the same `state_dir` → `conflict`; stdin EOF → exit 0 within timeout + 1 s with no descendants; `--version` prints the four versions as JSON. Conformance fixture 1 (initialize and shutdown) checked in under `fixtures/protocol/` and replayed by `fake-host --conformance`.

**Status:** not started

- [ ] `bun build --compile` produces a binary; `.bun-version` pinned
- [ ] `initialize` happy path and all four error cases
- [ ] Line limit, `$/cancel` framing, stderr JSON logs
- [ ] stdin EOF drain and exit; `engine.lock`
- [ ] `fake-host` with `--conformance`, fixture 1
- [ ] `--version`, `doctor` (presence of `sandbox-exec` only)
